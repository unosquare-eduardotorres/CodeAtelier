/**
 * BlueprintBuildService — orchestrates the BUILD phase of the Blueprint pipeline.
 *
 * Unlike previous phases (one-shot), BUILD iterates through tasks grouped by wave.
 * Each task gets its own AgentSessionService with write access (session.start('build')).
 *
 * Wave execution:
 * - Tasks within a wave execute sequentially (simpler, avoids file conflicts)
 * - If any task in a wave fails, remaining waves are aborted
 * - After all waves complete, auto-advances to VERIFY phase
 *
 * Follows the BlueprintReviewService pattern for event emission + error handling.
 */

import { EventEmitter } from 'node:events'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import type {
  BlueprintTask,
  BlueprintPhaseStartPayload,
  BlueprintPhaseProgressPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintWaveStartPayload,
  BlueprintWaveTaskStartPayload,
  BlueprintWaveTaskCompletePayload,
  BlueprintWaveCompletePayload
} from '../../shared/blueprint-types'
import { AgentSessionService } from './agent-session.service'
import { BlueprintBuildAdapter } from './role-adapters/blueprint/blueprint-build.adapter'
import { buildBuildGoalCondition } from './blueprint-goal-conditions'
import { blueprintVerifyService } from './blueprint-verify.service'
import { parsePhaseCompletionBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'

const bpLog = log.scope('blueprint-build')

const TASK_TIMEOUT_MS = 30 * 60_000 // 30 min per task

/** Mutable accumulator passed through wave/task execution. */
interface BuildResult {
  tasksCompleted: number
  filesCreated: string[]
  filesModified: string[]
  failed: boolean
}

export class BlueprintBuildService extends EventEmitter {
  /** Active session for the currently executing task (used for cancel). */
  private activeSession: AgentSessionService | null = null
  private activeBlueprintId: string | null = null

  async startBuildPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startBuildPhase] Blueprint ${blueprintId} — starting BUILD`)

    // 1. Pipeline + DB state
    blueprintService.markPipelineRunning(workspaceId, blueprintId, 'build')
    this.activeBlueprintId = blueprintId

    const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
    if (buildPhase) {
      blueprintPhaseRepository.updateStatus(buildPhase.id, 'active')
    }

    blueprintRepository.updateStatus(blueprintId, 'building')
    blueprintRepository.update(blueprintId, { currentPhase: 'build' })

    // 2. Assemble phase context (includes spec + clarify + plan + tasks + review artifacts)
    const phaseContext = blueprintService.assemblePhaseContext(blueprintId, 'build')

    // 3. Get tasks by wave
    const waveMap = blueprintService.getTasksByWave(blueprintId)
    const sortedWaves = [...waveMap.keys()].sort((a, b) => a - b)
    const totalTasks = [...waveMap.values()].reduce((sum, tasks) => sum + tasks.length, 0)

    bpLog.info(`[startBuildPhase] ${sortedWaves.length} waves, ${totalTasks} tasks total`)

    // 4. Emit phaseStart
    this.emit('phaseStart', {
      blueprintId, workspaceId, phase: 'build'
    } satisfies BlueprintPhaseStartPayload)

    const result: BuildResult = { tasksCompleted: 0, filesCreated: [], filesModified: [], failed: false }
    let verifyTriggered = false

    try {
      // 5. Execute waves sequentially
      for (const waveNum of sortedWaves) {
        const waveTasks = waveMap.get(waveNum) ?? []
        await this.executeWave({
          waveNum, waveTasks, blueprintId, workspaceId, workspacePath, phaseContext, result
        })
        if (result.failed) break
      }

      // 6. Save build phase artifact (summary)
      if (buildPhase) {
        const summary = this.buildArtifactSummary(result.tasksCompleted, totalTasks, result.filesCreated, result.filesModified)
        blueprintPhaseRepository.appendArtifact(buildPhase.id, {
          type: 'build',
          contentMd: summary,
          contentJson: { tasksCompleted: result.tasksCompleted, totalTasks, filesCreated: result.filesCreated, filesModified: result.filesModified }
        })
      }

      if (result.failed) {
        this.finalizeFailed(blueprintId, workspaceId, buildPhase?.id ?? null)
      } else {
        this.finalizeSuccess(blueprintId, workspaceId, workspacePath, buildPhase?.id ?? null, result, totalTasks)
        verifyTriggered = true
      }
    } catch (err) {
      bpLog.error(`[startBuildPhase] BUILD phase failed:`, err)
      this.finalizeFailed(blueprintId, workspaceId, buildPhase?.id ?? null)
    } finally {
      this.activeSession = null
      this.activeBlueprintId = null
      // Only mark pipeline stopped if verify was NOT auto-triggered.
      // When verify is triggered, its own finally block owns markPipelineStopped()
      // to avoid destroying the AbortController that the verify phase needs.
      if (!verifyTriggered) {
        blueprintService.markPipelineStopped(workspaceId)
      }
    }
  }

  // ── Wave Execution ──

  /**
   * Execute all tasks in a single wave sequentially.
   * Sets result.failed = true if any task fails or abort signal fires.
   */
  private async executeWave(params: {
    waveNum: number
    waveTasks: BlueprintTask[]
    blueprintId: string
    workspaceId: string
    workspacePath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
  }): Promise<void> {
    const { waveNum, waveTasks, blueprintId, workspaceId, workspacePath, phaseContext, result } = params

    this.emit('waveStart', {
      blueprintId, workspaceId, wave: waveNum, taskCount: waveTasks.length
    } satisfies BlueprintWaveStartPayload)

    bpLog.info(`[executeWave] Wave ${waveNum}: ${waveTasks.length} tasks`)

    let waveFailed = false

    for (const task of waveTasks) {
      // Check for abort before starting each task
      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      if (abortSignal?.aborted) {
        bpLog.info(`[executeWave] Aborted before task ${task.taskId}`)
        result.failed = true
        break
      }

      this.emit('waveTaskStart', {
        blueprintId, workspaceId, wave: waveNum, taskId: task.taskId,
        description: task.description
      } satisfies BlueprintWaveTaskStartPayload)

      blueprintTaskRepository.updateStatus(task.id, 'running')

      const taskResult = await this.executeTask({
        task, blueprintId, workspaceId, workspacePath, phaseContext
      })

      if (taskResult.success) {
        blueprintTaskRepository.updateStatus(task.id, 'complete')
        result.tasksCompleted++
        if (taskResult.completion?.filesCreated) {
          result.filesCreated.push(...(taskResult.completion.filesCreated as string[]))
        }
        if (taskResult.completion?.filesModified) {
          result.filesModified.push(...(taskResult.completion.filesModified as string[]))
        }
      } else {
        blueprintTaskRepository.updateStatus(task.id, 'failed')
        waveFailed = true
      }

      this.emit('waveTaskComplete', {
        blueprintId, workspaceId, wave: waveNum, taskId: task.taskId,
        status: taskResult.success ? 'complete' : 'failed'
      } satisfies BlueprintWaveTaskCompletePayload)

      if (waveFailed) {
        bpLog.warn(`[executeWave] Task ${task.taskId} failed — aborting wave ${waveNum}`)
        break
      }
    }

    const waveStatus = waveFailed || result.failed ? 'failed' : 'complete'
    this.emit('waveComplete', {
      blueprintId, workspaceId, wave: waveNum, status: waveStatus
    } satisfies BlueprintWaveCompletePayload)

    if (waveFailed) {
      bpLog.warn(`[executeWave] Wave ${waveNum} failed — aborting remaining waves`)
      result.failed = true
    }
  }

  // ── Phase Finalization ──

  private finalizeFailed(blueprintId: string, workspaceId: string, buildPhaseId: string | null): void {
    if (buildPhaseId) {
      blueprintPhaseRepository.updateStatus(buildPhaseId, 'failed')
    }

    // Guard: don't overwrite 'cancelled' status
    const currentStatus = blueprintRepository.findById(blueprintId)?.status
    if (currentStatus !== 'cancelled') {
      blueprintRepository.updateStatus(blueprintId, 'failed')
    }

    this.emit('phaseComplete', {
      blueprintId, workspaceId, phase: 'build', status: 'failed'
    } satisfies BlueprintPhaseCompletePayload)
  }

  private finalizeSuccess(
    blueprintId: string,
    workspaceId: string,
    workspacePath: string,
    buildPhaseId: string | null,
    result: BuildResult,
    totalTasks: number
  ): void {
    if (buildPhaseId) {
      blueprintPhaseRepository.updateStatus(buildPhaseId, 'complete')
    }

    // NOTE: DB state transitions (status='verifying', currentPhase='verify', verifyPhase='active')
    // are owned by blueprintVerifyService.startVerifyPhase() — not duplicated here.

    bpLog.info(`[finalizeSuccess] Blueprint ${blueprintId} — build complete (${result.tasksCompleted}/${totalTasks} tasks), advancing to VERIFY`)

    this.emit('phaseComplete', {
      blueprintId, workspaceId, phase: 'build', status: 'complete',
      completion: { tasksCompleted: result.tasksCompleted, totalTasks, filesCreated: result.filesCreated, filesModified: result.filesModified }
    } satisfies BlueprintPhaseCompletePayload)

    this.emit('phaseArtifact', {
      blueprintId, workspaceId, phase: 'build',
      artifact: {
        type: 'build',
        contentMd: this.buildArtifactSummary(result.tasksCompleted, totalTasks, result.filesCreated, result.filesModified)
      }
    } satisfies BlueprintPhaseArtifactPayload)

    // Auto-trigger VERIFY phase (non-blocking)
    blueprintVerifyService.startVerifyPhase({
      blueprintId, workspaceId, workspacePath
    }).catch((err) => {
      bpLog.error('[build→verify] Verify phase failed:', err)
    })
  }

  // ── Task Execution ──

  /**
   * Execute a single BUILD task in its own AgentSessionService.
   * Returns success/failure + parsed completion payload.
   */
  private async executeTask(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
  }): Promise<{ success: boolean; completion: Record<string, unknown> | null }> {
    const { task, blueprintId, workspaceId, workspacePath, phaseContext } = params

    bpLog.info(`[executeTask] Task ${task.taskId}: ${task.description.slice(0, 80)}`)

    // Build task-specific context string
    const taskContext = this.buildTaskContext(task)

    // Create adapter + session
    const adapter = new BlueprintBuildAdapter({
      workspaceId, blueprintId, phaseContext, taskContext
    })
    adapter.setGoalCondition(buildBuildGoalCondition(task.taskId, task.description))

    const session = new AgentSessionService(adapter)
    this.activeSession = session

    // Wire streaming — forward progress events
    const onChunk = (chunk: StreamChunk): void => {
      if (chunk.type === 'text' && chunk.content) {
        this.emit('phaseProgress', {
          blueprintId, workspaceId, phase: 'build', text: chunk.content
        } satisfies BlueprintPhaseProgressPayload)
      }
    }
    const onStatus = (status: AgentStatus): void => {
      this.emit('status', { workspaceId, status })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    try {
      // Start session in BUILD mode (write access)
      await session.start(workspacePath, 'build')

      const syntheticConvId = `blueprint-build-${blueprintId}-${task.taskId}-${Date.now()}`

      // Race: send vs timeout vs abort
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Task ${task.taskId} timeout`)), TASK_TIMEOUT_MS)
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      const abortPromise = new Promise<void>((_, reject) => {
        if (abortSignal?.aborted) { reject(new Error('Phase cancelled')); return }
        abortSignal?.addEventListener('abort', () => reject(new Error('Phase cancelled')), { once: true })
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      // Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text)

      bpLog.info(`[executeTask] Task ${task.taskId} complete — status: ${completion?.status ?? 'unknown'}`)

      return { success: true, completion }
    } catch (err) {
      bpLog.error(`[executeTask] Task ${task.taskId} failed:`, err)

      // Save partial output if available
      const partialText = session.getStreamedContent()
      if (partialText) {
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.appendArtifact(buildPhase.id, {
            type: 'build-partial',
            contentMd: `## Task ${task.taskId} (partial)\n\n${partialText}`
          })
        }
      }

      return { success: false, completion: null }
    } finally {
      session.removeListener('chunk', onChunk)
      session.removeListener('statusUpdate', onStatus)
      await session.stop()
      if (this.activeSession === session) {
        this.activeSession = null
      }
    }
  }

  // ── Task Context Builder ──

  /**
   * Format a BlueprintTask into a context string for the adapter.
   * Includes task ID, description, file paths, user story, and dependencies.
   */
  private buildTaskContext(task: BlueprintTask): string {
    const lines: string[] = [
      `**Task ID**: ${task.taskId}`,
      `**Wave**: ${task.wave}`,
      `**Description**: ${task.description}`
    ]

    if (task.userStory) {
      lines.push(`**User Story**: ${task.userStory}`)
    }

    if (task.filePathsJson?.length) {
      lines.push(`**Files**: ${task.filePathsJson.join(', ')}`)
    }

    if (task.dependsOnJson?.length) {
      lines.push(`**Depends On**: ${task.dependsOnJson.join(', ')}`)
    }

    return lines.join('\n')
  }

  // ── Artifact Summary ──

  private buildArtifactSummary(
    tasksCompleted: number,
    totalTasks: number,
    filesCreated: string[],
    filesModified: string[]
  ): string {
    const lines = [
      `# Build Phase Summary`,
      '',
      `**Tasks**: ${tasksCompleted}/${totalTasks} completed`,
      ''
    ]

    if (filesCreated.length) {
      lines.push(`**Files Created** (${filesCreated.length}):`)
      for (const f of filesCreated.slice(0, 50)) {
        lines.push(`- ${f}`)
      }
      lines.push('')
    }

    if (filesModified.length) {
      lines.push(`**Files Modified** (${filesModified.length}):`)
      for (const f of filesModified.slice(0, 50)) {
        lines.push(`- ${f}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // ── Cancel / Shutdown ──

  async cancelBlueprint(blueprintId: string): Promise<void> {
    if (this.activeBlueprintId === blueprintId && this.activeSession) {
      bpLog.info(`[cancelBlueprint] Stopping active session for blueprint ${blueprintId}`)
      await this.activeSession.stop()
      this.activeSession = null
      this.activeBlueprintId = null
    }
  }

  async shutdown(): Promise<void> {
    if (this.activeSession) {
      await this.activeSession.stop()
      this.activeSession = null
      this.activeBlueprintId = null
    }
  }
}

export const blueprintBuildService = new BlueprintBuildService()
