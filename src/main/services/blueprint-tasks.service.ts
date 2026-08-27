/**
 * BlueprintTasksService — orchestrates the TASKS phase of the Blueprint pipeline.
 *
 * One-shot: creates a fresh AgentSessionService, sends the task decomposition request,
 * parses the blueprint-tasks artifact, persists tasks to DB, and advances to REVIEW.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
  STALL_TIMEOUT_MS,
  wireAskUserAutoResponder
} from './blueprint-phase-watchdog'
import { AgentSessionService } from './agent-session.service'
import { BlueprintTasksAdapter } from './role-adapters/blueprint/blueprint-tasks.adapter'
import { buildTasksGoalCondition } from './blueprint-goal-conditions'
import {
  parsePhaseCompletionBlock,
  parseBlueprintTasks,
  parseDiscoveriesBlock
} from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import { modelConfigService } from './model-config.service'
import { blueprintReviewService } from './blueprint-review.service'
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

const bpLog = log.scope('blueprint-tasks')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintTasksService extends EventEmitter {
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

  async startTasksPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startTasksPhase] Blueprint ${blueprintId} — starting TASKS`)

    // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
    // finally's markPipelineStopped() is guaranteed to run.
    let tasksPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined
    let session: AgentSessionService | null = null
    // BP-CHAIN-TASKS-REVIEW: Method-local (not instance field) to avoid race across concurrent workspaces.
    let pendingReviewDispatch: {
      blueprintId: string
      workspaceId: string
      workspacePath: string
    } | null = null
    let cleanupAskUser: (() => void) | undefined
    // BP-CATCH-SCOPE-01: Hoisted outside try so the catch block (partial-output save) can read it.
    let syntheticConvId: string | undefined

    try {
      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'tasks')

      tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'tasks')
      if (tasksPhase) {
        blueprintPhaseRepository.updateStatus(tasksPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'tasking')
      blueprintRepository.update(blueprintId, { currentPhase: 'tasks' })

      // 2. Assemble context (includes spec + clarify + plan artifacts + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'tasks',
        workspacePath
      )

      // 3. Create adapter + session
      const adapter = new BlueprintTasksAdapter({ workspaceId, blueprintId, phaseContext })

      const blueprint = blueprintService.getBlueprint(blueprintId)
      adapter.setGoalCondition(buildTasksGoalCondition(blueprint?.title ?? 'Unknown'), 'enforce')

      session = new AgentSessionService(adapter)

      // 4. Emit phaseStart
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'tasks',
        goal: buildTasksGoalCondition(blueprint?.title ?? 'Unknown')
      } satisfies BlueprintPhaseStartPayload)

      // 5. Wire streaming + stall watchdog
      const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'TASKS')

      session.on('chunk', (chunk: StreamChunk) => {
        stallWatchdog.touch()
        forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
          blueprintId,
          workspaceId,
          phase: 'tasks',
          workspacePath,
          mode: 'plan'
        })
      })

      session.on('statusUpdate', (status: AgentStatus) => {
        this.safeEmit('status', { workspaceId, status })
      })

      // B4-FIX: Auto-respond to ask_user calls — tasks is non-interactive
      cleanupAskUser = wireAskUserAutoResponder(session, 'TASKS')

      // 6. Start session + send with timeout + stall watchdog + abort race
      await session.start(workspacePath, 'plan')

      // BP-RETRY-CONV-REUSE: Check for prior conversation from failed attempt
      const tasksPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'tasks')
      const priorConvId = tasksPhaseRec?.conversationId
      if (priorConvId && conversationRepository.getSessionId(priorConvId)) {
        const priorConv = conversationRepository.findById(priorConvId)
        const currentProvider = modelConfigService.getProvider(workspacePath)
        if (priorConv?.llmProvider === currentProvider) {
          syntheticConvId = priorConvId
          bpLog.info(`[startTasksPhase] Resuming conversation ${priorConvId} from failed attempt`)
        } else {
          syntheticConvId = `blueprint-tasks-${blueprintId}-${Date.now()}`
          bpLog.info(`[startTasksPhase] Provider changed — falling back to fresh conversation`)
        }
      } else {
        syntheticConvId = `blueprint-tasks-${blueprintId}-${Date.now()}`
      }

      // Persist conversation ID early so retries can find it
      if (tasksPhaseRec) {
        try {
          blueprintPhaseRepository.setConversation(tasksPhaseRec.id, syntheticConvId)
        } catch {
          /* conversation may not exist yet in DB */
        }
      }

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('TASKS phase timeout')), PHASE_TIMEOUT_MS)
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
      const text = session.getStreamedContent(syntheticConvId)
      const completion = parsePhaseCompletionBlock(text, 'tasks') ?? undefined
      const tasksJson = parseBlueprintTasks(text)

      // 8. Save phase artifact
      if (tasksPhase) {
        // Replace, not append — same reason as PLAN: acceptRevision() rewinds to
        // TASKS and re-runs this phase, so appending would leave two 'tasks'
        // artifacts and REVIEW would receive both.
        blueprintPhaseRepository.replaceArtifactOfType(tasksPhase.id, 'tasks', {
          type: 'tasks',
          contentMd: text,
          contentJson: tasksJson ?? undefined
        })
        blueprintPhaseRepository.setConversation(tasksPhase.id, syntheticConvId)

        // 8b. Save discoveries artifact (if emitted)
        const discoveries = parseDiscoveriesBlock(text)
        if (discoveries?.length) {
          blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
            type: 'discoveries',
            contentJson: { phase: 'tasks', entries: discoveries }
          })
        }

        blueprintPhaseRepository.updateStatus(tasksPhase.id, 'complete')
        // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
        if (tasksPhase.contextSnapshot) {
          blueprintPhaseRepository.saveContextSnapshot(tasksPhase.id, null)
        }
      }

      // 9. Persist tasks to DB (via the parsed blueprint-tasks JSON)
      if (tasksJson) {
        this.persistTasksFromJson(blueprintId, tasksJson)
      }

      // 10. Advance to REVIEW phase
      blueprintRepository.updateStatus(blueprintId, 'reviewing')
      blueprintRepository.update(blueprintId, { currentPhase: 'review' })

      const reviewPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'review')
      if (reviewPhase) {
        blueprintPhaseRepository.updateStatus(reviewPhase.id, 'active')
      }

      bpLog.info(`[startTasksPhase] Blueprint ${blueprintId} — tasks complete, advancing to REVIEW`)

      // 11. Emit events
      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'tasks',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (tasksPhase) {
        this.safeEmit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'tasks',
          artifact: { type: 'tasks', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }

      // BP-CHAIN-TASKS-REVIEW: Auto-dispatch REVIEW after TASKS completes.
      pendingReviewDispatch = { blueprintId, workspaceId, workspacePath }
    } catch (err) {
      bpLog.error(`[startTasksPhase] TASKS phase failed:`, err)

      // Guard: don't overwrite 'cancelled' status
      const currentStatus = blueprintRepository.findById(blueprintId)?.status
      if (currentStatus !== 'cancelled') {
        if (tasksPhase) {
          blueprintPhaseRepository.updateStatus(tasksPhase.id, 'failed')
        }
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }

      const partialText = session?.getStreamedContent(syntheticConvId)
      if (partialText && tasksPhase) {
        blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
          type: 'tasks-partial',
          contentMd: partialText
        })
      }

      // M5: Use failPipeline to properly transition machine to 'failed' state
      const errorMsg = err instanceof Error ? err.message : String(err)
      blueprintService.failPipeline(workspaceId, errorMsg)

      // BP-RETRY-CONTEXT: Save structured retry context for next attempt
      try {
        blueprintService.saveRetryContext(blueprintId, 'tasks', { error: errorMsg })
      } catch {
        /* best effort */
      }

      const autoRetrying = blueprintService.scheduleAutoRetry({
        blueprintId,
        workspaceId,
        workspacePath,
        phase: 'tasks',
        error: errorMsg
      })

      this.safeEmit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'tasks',
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

      // BP-CHAIN-TASKS-REVIEW: Dispatch review AFTER releasing the pipeline lock.
      if (pendingReviewDispatch) {
        const pendingReview = pendingReviewDispatch
        const currentStatus = blueprintRepository.findById(pendingReview.blueprintId)?.status
        if (currentStatus !== 'cancelled') {
          try {
            blueprintReviewService.startReviewPhase(pendingReview).catch((err) => {
              bpLog.error('[tasks→review] Review phase failed:', err)
            })
          } catch (syncErr) {
            bpLog.error('[tasks→review] Review startup failed (sync):', syncErr)
          }
        }
      }
    }
  }

  // ── Task Persistence ──

  /**
   * Extract tasks from the parsed blueprint-tasks JSON and persist them via
   * blueprintService.populateTasks(). Handles the wave-nested format from the prompt.
   */
  private persistTasksFromJson(blueprintId: string, tasksJson: Record<string, unknown>): void {
    try {
      const waves = tasksJson.waves as
        | Array<{
            wave: number
            tasks: Array<{
              taskId: string
              description: string
              files?: string[]
              userStory?: string | null
              isParallel?: boolean
              dependsOn?: string[]
            }>
          }>
        | undefined

      if (!waves?.length) {
        bpLog.warn(`[persistTasksFromJson] No waves found in tasks JSON`)
        return
      }

      const flatTasks = waves.flatMap((w) =>
        w.tasks.map((t) => ({
          taskId: t.taskId,
          wave: w.wave,
          description: t.description,
          userStory: t.userStory ?? undefined,
          files: t.files,
          isParallel: t.isParallel,
          dependsOn: t.dependsOn
        }))
      )

      const persisted = blueprintService.populateTasks(blueprintId, flatTasks)
      bpLog.info(
        `[persistTasksFromJson] Persisted ${persisted.length} tasks across ${waves.length} waves`
      )
    } catch (err) {
      bpLog.error(`[persistTasksFromJson] Failed to persist tasks:`, err)
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

export const blueprintTasksService = new BlueprintTasksService()
