/**
 * BlueprintVerifyService — orchestrates the VERIFY phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the verify request,
 * parses the completion block with verification results, saves the artifact,
 * and determines the final blueprint status.
 *
 * VERIFY is the terminal phase — no approval gate, no next phase.
 *
 * Three completion outcomes:
 * - overallStatus: 'passed'       → blueprint.status = 'complete'
 * - overallStatus: 'human_needed' → blueprint.status = 'complete' (flagged)
 * - overallStatus: 'gaps_found'   → blueprint.status = 'failed'
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { AgentSessionService } from './agent-session.service'
import { BlueprintVerifyAdapter } from './role-adapters/blueprint/blueprint-verify.adapter'
import { buildVerifyGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-verify')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintVerifyService extends EventEmitter {
  async startVerifyPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startVerifyPhase] Blueprint ${blueprintId} — starting VERIFY`)

    // BP-VERIFY-INIT-OUTSIDE-TRY-01: All initialization is now inside the
    // try-finally so that session.stop() and markPipelineStopped() always
    // run, even if markPipelineRunning or adapter creation throws.
    let session: AgentSessionService | null = null
    let onChunk: ((chunk: StreamChunk) => void) | null = null
    let onStatus: ((status: AgentStatus) => void) | null = null
    let verifyPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined

    try {
      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'verify')

      verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
      if (verifyPhase) {
        blueprintPhaseRepository.updateStatus(verifyPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'verifying')
      blueprintRepository.update(blueprintId, { currentPhase: 'verify' })

      // 2. Assemble context (includes ALL prior artifacts: spec → build)
      const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'verify')

      // 3. Create adapter + session
      const adapter = new BlueprintVerifyAdapter({ workspaceId, blueprintId, phaseContext })

      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(buildVerifyGoalCondition(blueprint?.title ?? 'Unknown'))

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.emit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'verify'
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming — named handlers for cleanup
      onChunk = (chunk: StreamChunk): void => {
        if (chunk.type === 'text' && chunk.content) {
          this.emit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'verify',
            text: chunk.content
          } satisfies BlueprintPhaseProgressPayload)
        }
      }
      onStatus = (status: AgentStatus): void => {
        this.emit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // 6. Start session in READ-ONLY mode + send with timeout + abort race
      await session.start(workspacePath, 'plan')

      const syntheticConvId = `blueprint-verify-${blueprintId}-${Date.now()}`

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('VERIFY phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      // BP-ABORT-TOCTOU-01: Attach listener BEFORE checking aborted status to
      // close the race window where the signal fires between check and addEventListener.
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', onAbort, { once: true })
        if (abortSignal?.aborted) {
          onAbort()
        }
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise])
      } catch (err) {
        // BP-VERIFY-TIMEOUT-01: Cancel the in-flight query when timeout/abort wins the race.
        // Without this, session.send() continues streaming in the background while
        // the outer catch handler tries to clean up — causing a race between the
        // active stream and session.stop() in the finally block.
        try {
          session.cancelCurrentQuery()
        } catch {
          /* best-effort — session may already be stopped */
        }
        throw err
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined

      // 8. Save phase artifact
      if (verifyPhase) {
        blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
          type: 'verify',
          contentMd: text,
          contentJson: completion ?? undefined
        })
        blueprintPhaseRepository.setConversation(verifyPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(verifyPhase.id, 'complete')
      }

      const overallStatus = (completion?.overallStatus as string) ?? 'unknown'
      bpLog.info(
        `[startVerifyPhase] Blueprint ${blueprintId} — verify complete, overallStatus: ${overallStatus}`
      )

      // 9. Determine final blueprint status
      // BP-03: Only explicit 'passed' or 'human_needed' → complete.
      // 'unknown' (parse failure / truncation) and 'gaps_found' → failed.
      // BP-VERIFY-CANCEL-OVERWRITE-01: Guard against overwriting 'cancelled' status.
      // Matches the existing guard in the error path (line 186-193).
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (overallStatus === 'passed' || overallStatus === 'human_needed') {
          blueprintRepository.updateStatus(blueprintId, 'complete')
        } else {
          blueprintRepository.updateStatus(blueprintId, 'failed')
        }
      }

      // 10. Emit phaseComplete
      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (verifyPhase) {
        this.emit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          artifact: { type: 'verify', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }
    } catch (err) {
      bpLog.error(`[startVerifyPhase] VERIFY phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (verifyPhase) {
          blueprintPhaseRepository.updateStatus(verifyPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent()
      if (partialText && verifyPhase) {
        blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
          type: 'verify-partial',
          contentMd: partialText
        })
      }

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        await session.stop()
      }
      blueprintService.markPipelineStopped(workspaceId)
    }
  }

  /** Cancel (one-shot — handled by AbortController in blueprintService.cancel()). */
  async cancelBlueprint(_blueprintId: string): Promise<void> {
    // One-shot — no session map to clean up.
  }

  async shutdown(): Promise<void> {
    // One-shot — no persistent sessions to clean up.
  }
}

export const blueprintVerifyService = new BlueprintVerifyService()
