/**
 * BlueprintPlanService — orchestrates the PLAN phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the planning request,
 * parses both the blueprint-plan artifact and the phase completion block.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import { PhaseActivityWatchdog, STALL_TIMEOUT_MS, wireAskUserAutoResponder } from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintPlanAdapter } from './role-adapters/blueprint/blueprint-plan.adapter'
import { buildPlanGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, parseBlueprintPlan, parseDiscoveriesBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import { modelConfigService } from './model-config.service'
import { blueprintTasksService } from './blueprint-tasks.service'
import {
  blueprintRepository,
  blueprintPhaseRepository
} from '../db/repositories/blueprint.repository'
import { conversationRepository } from '../db/repositories'
import type {
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload
} from '../../shared/blueprint-types'

const bpLog = log.scope('blueprint-plan')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintPlanService extends EventEmitter {

  // BP-PHASE-RAW-EMIT-01: Error-isolated emit prevents listener throws from
  // crashing the pipeline. Mirrors safeEmit() in BlueprintBuildService/VerifyService.
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  async startPlanPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startPlanPhase] Blueprint ${blueprintId} — starting PLAN`)

    // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
    // finally's markPipelineStopped() is guaranteed to run.
    let planPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined
    let session: AgentSessionService | null = null
    // BP-CHAIN-PLAN-TASKS: Method-local (not instance field) to avoid race across concurrent workspaces.
    let pendingTasksDispatch: { blueprintId: string; workspaceId: string; workspacePath: string } | null = null
    let cleanupAskUser: (() => void) | undefined

    try {
      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'plan')

      planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
      if (planPhase) {
        blueprintPhaseRepository.updateStatus(planPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'planning')
      blueprintRepository.update(blueprintId, { currentPhase: 'plan' })

      // 2. Assemble context (includes spec + clarify artifacts + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(blueprintId, 'plan', workspacePath)

      // 3. Create adapter + session
      const adapter = new BlueprintPlanAdapter({ workspaceId, blueprintId, phaseContext })

      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(buildPlanGoalCondition(blueprint?.title ?? 'Unknown'), 'enforce')

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'plan',
        goal: buildPlanGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'PLAN')

      session.on('chunk', (chunk: StreamChunk) => {
        stallWatchdog.touch()
        forwardBlueprintChunk(
          (event, payload) => this.safeEmit(event, payload),
          chunk,
          { blueprintId, workspaceId, phase: 'plan', workspacePath, mode: 'plan' }
        )
      })

      session.on('statusUpdate', (status: AgentStatus) => {
        this.safeEmit('status', { workspaceId, status })
      })

      // B4-FIX: Auto-respond to ask_user calls — plan is non-interactive
      cleanupAskUser = wireAskUserAutoResponder(session, 'PLAN')

      // 6. Start session + send with timeout + stall watchdog
      await session.start(workspacePath, 'plan')

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const planPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
      const priorConvId = planPhaseRec?.conversationId
      let syntheticConvId: string
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
          bpLog.info(`[startPlanPhase] Resuming conversation ${priorConvId} from failed attempt`)
        } else {
          syntheticConvId = `blueprint-plan-${blueprintId}-${Date.now()}`
          bpLog.info(`[startPlanPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-plan-${blueprintId}-${Date.now()}`
      }

      // Persist conversation ID early so retries can find it
      if (planPhaseRec) {
        try { blueprintPhaseRepository.setConversation(planPhaseRec.id, syntheticConvId) }
        catch { /* conversation may not exist yet in DB */ }
      }

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('PLAN phase timeout')), PHASE_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      // BP-ABORT-TOCTOU-02: Attach listener BEFORE checking aborted status to
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
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
      }

      // 7. Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text, 'plan') ?? undefined
      const planJson = parseBlueprintPlan(text)

      // 8. Save artifacts
      if (planPhase) {
        blueprintPhaseRepository.appendArtifact(planPhase.id, {
          type: 'plan',
          contentMd: text,
          contentJson: planJson ?? undefined
        })
        blueprintPhaseRepository.setConversation(planPhase.id, syntheticConvId)

        // 8b. Save discoveries artifact (if emitted)
        const discoveries = parseDiscoveriesBlock(text)
        if (discoveries?.length) {
          blueprintPhaseRepository.appendArtifact(planPhase.id, {
            type: 'discoveries',
            contentJson: { phase: 'plan', entries: discoveries }
          })
        }

        blueprintPhaseRepository.updateStatus(planPhase.id, 'complete')
        // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
        if (planPhase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(planPhase.id, null)
        }
      }

      // 9. Advance to TASKS phase
      // BP-04: Use correct status 'tasking' (not 'planning') for tasks phase
      blueprintRepository.updateStatus(blueprintId, 'tasking')
      blueprintRepository.update(blueprintId, { currentPhase: 'tasks' })

      const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'tasks')
      if (tasksPhase) {
        blueprintPhaseRepository.updateStatus(tasksPhase.id, 'active')
      }

      bpLog.info(`[startPlanPhase] Blueprint ${blueprintId} — plan complete, advancing to TASKS`)

      // 10. Emit events
      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'plan',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (planPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'plan',
          artifact: { type: 'plan', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // BP-CHAIN-PLAN-TASKS: Auto-dispatch TASKS after PLAN completes.
      pendingTasksDispatch = { blueprintId, workspaceId, workspacePath }
    } catch (err) {
      bpLog.error(`[startPlanPhase] PLAN phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status set by blueprintService.cancel()
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (planPhase) {
          blueprintPhaseRepository.updateStatus(planPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent()
      if (partialText && planPhase) {
        blueprintPhaseRepository.appendArtifact(planPhase.id, {
          type: 'plan-partial',
          contentMd: partialText
        })
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try { blueprintService.saveRetryContext(blueprintId, 'plan', { error: errorMsg }) }
      catch { /* best effort */ }

      // Auto-retry once for transient failures (timeout, stall, CLI crash)
      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId, workspaceId, workspacePath, phase: 'plan', error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'plan',
        status: 'failed',
        error: errorMsg,
        ...(autoRetrying ? { autoRetry: true } : {})
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      cleanupAskUser?.()
      if (session) {
        await session.stop()
      }
      blueprintService.markPipelineStopped(workspaceId)

      // BP-CHAIN-PLAN-TASKS: Dispatch tasks AFTER releasing the pipeline lock.
      if (pendingTasksDispatch) {
        const pendingTasks = pendingTasksDispatch
        const currentStatus = blueprintRepository.findById(pendingTasks.blueprintId)?.status
        if (currentStatus !== 'cancelled') {
          try {
            blueprintTasksService
              .startTasksPhase(pendingTasks)
              .catch((err) => {
                bpLog.error('[plan→tasks] Tasks phase failed:', err)
              })
          } catch (syncErr) {
            bpLog.error('[plan→tasks] Tasks startup failed (sync):', syncErr)
          }
        }
      }
    }
  }

  /** Cancel active PLAN session for a blueprint (called from IPC cancel handler). */
  async cancelBlueprint(_blueprintId: string): Promise<void> {
    // PLAN is one-shot — cancellation is handled by the AbortController
    // in blueprintService.cancel(). No session map to clean up.
  }

  async shutdown(): Promise<void> {
    // One-shot — no persistent sessions to clean up.
  }
}

export const blueprintPlanService = new BlueprintPlanService()
