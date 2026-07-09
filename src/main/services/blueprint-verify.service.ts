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
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import { PhaseActivityWatchdog, STALL_TIMEOUT_MS } from './blueprint-phase-watchdog'
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
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-verify')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintVerifyService extends EventEmitter {
  // BP-VERIFY-RAW-EMIT-01: Error-isolated emit prevents listener throws from
  // crashing the VERIFY pipeline. Mirrors safeEmit() in BlueprintBuildService.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

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
      // BP-VERIFY-CANCEL-STATUS-CHECK-01 + BP-VERIFY-NULL-BLUEPRINT-01:
      // Check if the blueprint was cancelled or deleted during the BUILD→VERIFY
      // transition window. cancel() sets DB status to 'cancelled' even when
      // running=false; deletion removes the row entirely.
      const existingBlueprint = blueprintRepository.findById(blueprintId)
      if (!existingBlueprint || existingBlueprint.status === 'cancelled') {
        bpLog.info(`[startVerifyPhase] Blueprint ${blueprintId} ${!existingBlueprint ? 'deleted' : 'cancelled'} — skipping VERIFY`)
        return
      }

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
      adapter.setGoalCondition(buildVerifyGoalCondition(blueprint?.title ?? 'Unknown'), 'enforce')

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        goal: buildVerifyGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming — named handlers for cleanup + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'VERIFY')

      onChunk = (chunk: StreamChunk): void => {
        stallWatchdog.touch()
        forwardBlueprintChunk(
          (event, payload) => this.safeEmit(event, payload),
          chunk,
          { blueprintId, workspaceId, phase: 'verify', workspacePath, mode: 'plan' }
        )
      }
      onStatus = (status: AgentStatus): void => {
        this.safeEmit('status', { workspaceId, status })
      }
      session.on('chunk', onChunk)
      session.on('statusUpdate', onStatus)

      // 6. Start session in READ-ONLY mode + send with timeout + stall watchdog + abort race
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
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } catch (err) {
        // BP-VERIFY-TIMEOUT-01: Cancel the in-flight query when timeout/abort/stall wins the race.
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
        stallWatchdog.dispose()
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text) ?? undefined

      // 8. Save phase artifact
      const overallStatus = (completion?.overallStatus as string) ?? 'unknown'
      // BP-GAPS-FOUND-DEAD-END-FIX: When gaps_found and remediation is NOT
      // triggered, mark verify phase 'failed' (not 'complete') so retryPhase()
      // can find a retryable phase and the Retry banner renders. 'passed' and
      // 'human_needed' are genuine completions.
      const verifyPhaseStatus = (overallStatus === 'passed' || overallStatus === 'human_needed')
        ? 'complete' as const
        : 'failed' as const

      if (verifyPhase) {
        blueprintPhaseRepository.appendArtifact(verifyPhase.id, {
          type: 'verify',
          contentMd: text,
          contentJson: completion ?? undefined
        })
        blueprintPhaseRepository.setConversation(verifyPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(verifyPhase.id, verifyPhaseStatus)
      }

      bpLog.info(
        `[startVerifyPhase] Blueprint ${blueprintId} — verify ${verifyPhaseStatus}, overallStatus: ${overallStatus}`
      )

      // 9. Remediation check — when gaps_found with actionable tasks, auto-fix
      // BP-REMEDIATION-01: Parse remediationTasks from completion block.
      const remediationTasks = Array.isArray(completion?.remediationTasks)
        ? (completion.remediationTasks as Array<{
            taskId: string
            description: string
            files?: string[]
            dependsOn?: string[]
          }>)
        : []
      const currentBlueprint = blueprintRepository.findById(blueprintId)
      const currentSettings = currentBlueprint?.settingsJson ?? {}
      const remediationRound = (currentSettings.remediationRound as number) ?? 0
      const canRemediate =
        overallStatus === 'gaps_found' &&
        remediationTasks.length > 0 &&
        remediationRound < 2

      if (canRemediate) {
        // 9a. Append remediation tasks as new wave(s)
        bpLog.info(
          `[startVerifyPhase] gaps_found with ${remediationTasks.length} remediation task(s) — ` +
          `round ${remediationRound + 1}/2, appending tasks and re-triggering build`
        )
        blueprintService.appendTasks(blueprintId, remediationTasks)

        // 9b. Increment remediationRound in settingsJson
        blueprintRepository.update(blueprintId, {
          settingsJson: { ...currentSettings, remediationRound: remediationRound + 1 }
        })

        // 9c. Reset verify phase to pending, build to active, blueprint to building
        if (verifyPhase) {
          blueprintPhaseRepository.updateStatus(verifyPhase.id, 'pending')
        }
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.updateStatus(buildPhase.id, 'active')
        }
        blueprintRepository.update(blueprintId, {
          status: 'building' as import('../../shared/blueprint-types').BlueprintStatus,
          currentPhase: 'build'
        })

        // 9d. Emit system message
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          text: `Verification found gaps — adding ${remediationTasks.length} remediation task(s) (round ${remediationRound + 1}/2)`,
          kind: 'system'
        })

        // 9e. Emit remediationNeeded event after 5s delay (mirrors scheduleAutoRetry)
        // Lets the finally block release the pipeline lock first.
        setTimeout(() => {
          this.safeEmit('remediationNeeded', {
            blueprintId,
            workspaceId,
            workspacePath
          })
        }, 5000)

        // 10. Emit phaseComplete (remediation-triggered)
        this.safeEmit('phaseComplete', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          status: 'complete',
          completion
        } satisfies BlueprintPhaseCompletePayload)
      } else {
        // 10. Determine final blueprint status (no remediation)
        // BP-03: Only explicit 'passed' or 'human_needed' → complete.
        // 'unknown' (parse failure / truncation) and 'gaps_found' → failed.
        // BP-VERIFY-CANCEL-OVERWRITE-01: Guard against overwriting 'cancelled' status.
        const currentStatus = currentBlueprint?.status
        if (currentStatus !== 'cancelled') {
          if (overallStatus === 'passed' || overallStatus === 'human_needed') {
            blueprintRepository.updateStatus(blueprintId, 'complete')
          } else {
            blueprintRepository.updateStatus(blueprintId, 'failed')
          }
        }

        // Emit phaseComplete
        this.safeEmit('phaseComplete', {
          blueprintId,
          workspaceId,
          phase: 'verify',
          status: verifyPhaseStatus,
          completion
        } satisfies BlueprintPhaseCompletePayload)
      }

      if (verifyPhase) {
        this.safeEmit('phaseArtifact', {
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

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId, workspaceId, workspacePath, phase: 'verify', error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'verify',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      if (session) {
        if (onChunk) session.removeListener('chunk', onChunk)
        if (onStatus) session.removeListener('statusUpdate', onStatus)
        // BP-SESSION-LEAK-01: Wrap session.stop() in its own try-catch so a
        // stop() failure doesn't skip markPipelineStopped(), stranding the
        // pipeline in phase-running with state.running=true permanently.
        try {
          await session.stop()
        } catch (err) {
          bpLog.error('[verify] session.stop() failed:', err)
        }
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
