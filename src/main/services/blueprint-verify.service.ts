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

    // 1. Pipeline + DB state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'verify')

    const verifyPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
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

    const session = new AgentSessionService(adapter)

    // 4. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'verify'
    } satisfies BlueprintPhaseStartPayload)

    // 5. Wire streaming — named handlers for cleanup
    const onChunk = (chunk: StreamChunk): void => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    }
    const onStatus = (status: AgentStatus): void => {
      this.emit('status', { workspaceId, status })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    try {
      // 6. Start session in READ-ONLY mode + send with timeout + abort race
      await session.start(workspacePath, 'plan')

      const syntheticConvId = `blueprint-verify-${blueprintId}-${Date.now()}`

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('VERIFY phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('Phase cancelled'))
          return
        }
        abortSignal?.addEventListener('abort', () => reject(new Error('Phase cancelled')), {
          once: true
        })
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise])
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
      if (overallStatus === 'passed' || overallStatus === 'human_needed') {
        blueprintRepository.updateStatus(blueprintId, 'complete')
      } else {
        blueprintRepository.updateStatus(blueprintId, 'failed')
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

      const partialText = session.getStreamedContent()
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
      session.removeListener('chunk', onChunk)
      session.removeListener('statusUpdate', onStatus)
      await session.stop()
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
