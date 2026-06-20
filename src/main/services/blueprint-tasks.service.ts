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
import { AgentSessionService } from './agent-session.service'
import { BlueprintTasksAdapter } from './role-adapters/blueprint/blueprint-tasks.adapter'
import { buildTasksGoalCondition } from './blueprint-goal-conditions'
import { parsePhaseCompletionBlock, parseBlueprintTasks } from './blueprint-artifact-parsers'
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

const bpLog = log.scope('blueprint-tasks')

const PHASE_TIMEOUT_MS = 30 * 60_000 // 30 min

export class BlueprintTasksService extends EventEmitter {
  async startTasksPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startTasksPhase] Blueprint ${blueprintId} — starting TASKS`)

    // 1. Pipeline + DB state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'tasks')

    const tasksPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'tasks')
    if (tasksPhase) {
      blueprintPhaseRepository.updateStatus(tasksPhase.id, 'active')
    }

    blueprintRepository.updateStatus(blueprintId, 'tasking')
    blueprintRepository.update(blueprintId, { currentPhase: 'tasks' })

    // 2. Assemble context (includes spec + clarify + plan artifacts)
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'tasks')

    // 3. Create adapter + session
    const adapter = new BlueprintTasksAdapter({ workspaceId, blueprintId, phaseContext })

    const blueprint = blueprintService.getBlueprint(blueprintId)
    adapter.setGoalCondition(buildTasksGoalCondition(blueprint?.title ?? 'Unknown'))

    const session = new AgentSessionService(adapter)

    // 4. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId,
      workspaceId,
      phase: 'tasks'
    } satisfies BlueprintPhaseStartPayload)

    // 5. Wire streaming
    session.on('chunk', (chunk: StreamChunk) => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'tasks',
          text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    })

    session.on('statusUpdate', (status: AgentStatus) => {
      this.emit('status', { workspaceId, status })
    })

    try {
      // 6. Start session + send with timeout + abort race
      await session.start(workspacePath, 'plan')

      const syntheticConvId = `blueprint-tasks-${blueprintId}-${Date.now()}`

      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('TASKS phase timeout')), PHASE_TIMEOUT_MS)
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
      const completion = parsePhaseCompletionBlock(text)
      const tasksJson = parseBlueprintTasks(text)

      // 8. Save phase artifact
      if (tasksPhase) {
        blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
          type: 'tasks',
          contentMd: text,
          contentJson: tasksJson ?? undefined
        })
        blueprintPhaseRepository.setConversation(tasksPhase.id, syntheticConvId)
        blueprintPhaseRepository.updateStatus(tasksPhase.id, 'complete')
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
      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'tasks',
        status: 'complete',
        completion
      } satisfies BlueprintPhaseCompletePayload)

      if (tasksPhase) {
        this.emit('phaseArtifact', {
          blueprintId,
          workspaceId,
          phase: 'tasks',
          artifact: { type: 'tasks', contentMd: text }
        } satisfies BlueprintPhaseArtifactPayload)
      }
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

      const partialText = session.getStreamedContent()
      if (partialText && tasksPhase) {
        blueprintPhaseRepository.appendArtifact(tasksPhase.id, {
          type: 'tasks-partial',
          contentMd: partialText
        })
      }

      this.emit('phaseComplete', {
        blueprintId,
        workspaceId,
        phase: 'tasks',
        status: 'failed'
      } satisfies BlueprintPhaseCompletePayload)
    } finally {
      await session.stop()
      blueprintService.markPipelineStopped(workspaceId)
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
