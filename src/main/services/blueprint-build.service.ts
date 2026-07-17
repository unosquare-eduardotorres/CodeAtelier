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
import { normalize } from 'node:path'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import { PhaseActivityWatchdog, STALL_TIMEOUT_MS, wireAskUserAutoResponder } from './blueprint-phase-watchdog'
import type {
  BlueprintTask,
  BlueprintPhaseStartPayload,
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
import { parsePhaseCompletionBlock, parseDiscoveriesBlock } from './blueprint-artifact-parsers'
import { blueprintService } from './blueprint.service'
import { codeGraphService } from './code-graph.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'

const bpLog = log.scope('blueprint-build')

const TASK_TIMEOUT_MS = 30 * 60_000 // 30 min per task

/** Mutable accumulator passed through wave/task execution. */
interface BuildResult {
  tasksCompleted: number
  tasksResumed: number
  filesCreated: string[]
  filesModified: string[]
  failed: boolean
  /** Accumulated discoveries from all completed build tasks (capped at 20). */
  discoveries: string[]
}

/** In-flight task metadata for the parallel scheduler. */
interface InFlightEntry {
  promise: Promise<{ success: boolean; completion: Record<string, unknown> | null; discoveries: string[] }>
  files: Set<string>
  task: BlueprintTask
}

/** Normalize file paths for overlap comparison. */
function normalizePaths(paths: string[] | undefined): Set<string> {
  if (!paths?.length) return new Set()
  return new Set(paths.map((p) => normalize(p)))
}

/** Check whether two file sets overlap. */
function filesOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const f of a) {
    if (b.has(f)) return true
  }
  return false
}

export class BlueprintBuildService extends EventEmitter {
  /** BP-05: Per-workspace active session sets (multiple for parallel tasks). */
  private activeSessions = new Map<string, Set<AgentSessionService>>()
  private activeBlueprintIds = new Map<string, string>()
  /** G2: Per-task status tracking for derived workspace status. */
  private perTaskStatus = new Map<string, AgentStatus['status']>()

  async startBuildPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startBuildPhase] Blueprint ${blueprintId} — starting BUILD`)

    const result: BuildResult = {
      tasksCompleted: 0,
      tasksResumed: 0,
      filesCreated: [],
      filesModified: [],
      failed: false,
      discoveries: []
    }
    let verifyTriggered = false
    let buildPhase: ReturnType<typeof blueprintPhaseRepository.findByBlueprintAndPhase> = undefined
    let sortedWaves: number[] = []
    let waveMap: ReturnType<typeof blueprintService.getTasksByWave> = new Map()
    let totalTasks = 0

    try {
      // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
      // finally's markPipelineStopped() is guaranteed to run.

      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'build')
      this.activeBlueprintIds.set(workspaceId, blueprintId)

      buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
      if (buildPhase) {
        blueprintPhaseRepository.updateStatus(buildPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'building')
      blueprintRepository.update(blueprintId, { currentPhase: 'build' })

      // 2. Assemble phase context (includes spec + clarify + plan + tasks + review artifacts + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(blueprintId, 'build', workspacePath)

      // 2b. Seed discoveries from prior phases + previous build runs (crash-resume)
      if (buildPhase) {
        for (const artifact of buildPhase.artifactsJson) {
          if (artifact.type === 'discoveries' && artifact.contentJson) {
            const entries = (artifact.contentJson as { entries?: string[] }).entries
            if (Array.isArray(entries)) {
              result.discoveries.push(...entries)
            }
          }
        }
      }
      // Also seed from upstream phase discoveries
      for (const artifact of phaseContext.previousArtifacts) {
        if (artifact.type === 'discoveries' && artifact.contentJson) {
          const entries = (artifact.contentJson as { entries?: string[] }).entries
          if (Array.isArray(entries)) {
            result.discoveries.push(...entries)
          }
        }
      }
      // Cap at 20 to prevent unbounded growth
      if (result.discoveries.length > 20) {
        result.discoveries = result.discoveries.slice(-20)
      }

      // BP-REMEDIATION-CONTEXT-01: During remediation builds, seed verify findings
      // into discoveries so agents know exactly what gaps to fix.
      // Uses structured contentJson (parsed completion) over raw contentMd to avoid
      // seeding the agent's preamble and to keep the context concise.
      const currentBlueprint = blueprintRepository.findById(blueprintId)
      const remediationRound = (currentBlueprint?.settingsJson as Record<string, unknown>)?.remediationRound as number | undefined
      if (remediationRound && remediationRound > 0) {
        const verifyPhaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'verify')
        if (verifyPhaseRecord) {
          const verifyArtifact = verifyPhaseRecord.artifactsJson.findLast((a) => a.type === 'verify')
          let gapSummary: string | undefined

          // Strategy 1: Extract structured findings from parsed completion JSON
          const completion = verifyArtifact?.contentJson as Record<string, unknown> | undefined
          if (completion) {
            const parts: string[] = []
            // Extract findings array (descriptions + file paths)
            const findings = completion.findings as Array<Record<string, unknown>> | undefined
            if (Array.isArray(findings) && findings.length > 0) {
              for (const f of findings.slice(0, 10)) {
                const desc = String(f.description ?? f.issue ?? 'Unknown gap')
                const files = Array.isArray(f.files) ? ` [${(f.files as string[]).slice(0, 5).join(', ')}]` : ''
                parts.push(`${desc}${files}`)
              }
              if (findings.length > 10) parts.push(`…and ${findings.length - 10} more`)
            }
            // Fallback: artifact gap counts
            if (parts.length === 0) {
              const artifacts = completion.artifacts as Record<string, unknown> | undefined
              if (artifacts) {
                const missing = (artifacts.missing as number) ?? 0
                const stub = (artifacts.stub as number) ?? 0
                const orphaned = (artifacts.orphaned as number) ?? 0
                if (missing + stub + orphaned > 0) {
                  parts.push(`Artifacts: ${missing} missing, ${stub} stub, ${orphaned} orphaned`)
                }
              }
            }
            if (parts.length > 0) {
              gapSummary = parts.join('; ')
            }
          }

          // Strategy 2: Fall back to raw contentMd (truncated from the END, where
          // findings are typically located, not the beginning which is preamble)
          if (!gapSummary && verifyArtifact?.contentMd) {
            const md = verifyArtifact.contentMd
            gapSummary = md.length > 1500
              ? '…' + md.slice(-1500)
              : md
          }

          if (gapSummary) {
            // Ensure summary fits in a single discovery entry (max 2000 chars)
            if (gapSummary.length > 2000) {
              gapSummary = gapSummary.slice(0, 2000) + '…[truncated]'
            }
            result.discoveries.push(
              `[VERIFY GAPS - Round ${remediationRound}] ${gapSummary}`
            )
            bpLog.info(`[startBuildPhase] Seeded verify findings (${gapSummary.length} chars) into remediation context`)
            // Re-apply cap after adding verify summary
            if (result.discoveries.length > 20) {
              result.discoveries = result.discoveries.slice(-20)
            }
          }
        }
      }

      // 3. Get tasks by wave
      waveMap = blueprintService.getTasksByWave(blueprintId)
      sortedWaves = [...waveMap.keys()].sort((a, b) => a - b)
      totalTasks = [...waveMap.values()].reduce((sum, tasks) => sum + tasks.length, 0)

      bpLog.info(`[startBuildPhase] ${sortedWaves.length} waves, ${totalTasks} tasks total`)

      // 3b. Bootstrap code-graph index if none exists — ensures Wave 1+ agents
      // get a populated graph for code-graph tool calls.
      if (!codeGraphService.hasPersistedIndex(workspaceId)) {
        try {
          bpLog.info(`[startBuildPhase] Bootstrapping code-graph index for ${workspaceId}`)
          await codeGraphService.indexWorkspace(workspaceId, workspacePath)
          bpLog.info(`[startBuildPhase] Code-graph bootstrap complete`)
        } catch (err) {
          bpLog.warn(`[startBuildPhase] Code-graph bootstrap failed (non-fatal):`, err)
        }
      }

      // 4. Emit phaseStart
      // BP-BUILD-TASK-RAW-EMIT-01: Use safeEmit to prevent listener throws
      // from aborting build initialization.
      this.safeEmit('phaseStart', {
        blueprintId,
        workspaceId,
        phase: 'build',
        goal: `Build ${totalTasks} tasks across ${sortedWaves.length} waves`,
        totalTasks,
        totalWaves: sortedWaves.length
      } satisfies BlueprintPhaseStartPayload)
      // 5. Execute waves sequentially
      for (const waveNum of sortedWaves) {
        const waveTasks = waveMap.get(waveNum) ?? []
        await this.executeWave({
          waveNum,
          waveTasks,
          blueprintId,
          workspaceId,
          workspacePath,
          phaseContext,
          result
        })
        if (result.failed) break
      }

      // 6. Save build phase artifact (summary)
      if (buildPhase) {
        const summary = this.buildArtifactSummary(
          result.tasksCompleted,
          totalTasks,
          result.filesCreated,
          result.filesModified,
          result.tasksResumed
        )
        blueprintPhaseRepository.appendArtifact(buildPhase.id, {
          type: 'build',
          contentMd: summary,
          contentJson: {
            tasksCompleted: result.tasksCompleted,
            tasksResumed: result.tasksResumed,
            totalTasks,
            filesCreated: result.filesCreated,
            filesModified: result.filesModified
          }
        })
      }

      if (result.failed) {
        // BP-SKIP-01 + BP-CLEANUP-RUNNING-TASKS-01: Mark all remaining pending/running
        // tasks across subsequent waves as 'skipped'
        for (const waveNum of sortedWaves) {
          const waveTasks = waveMap.get(waveNum) ?? []
          for (const task of waveTasks) {
            const currentStatus = blueprintTaskRepository.findById(task.id)?.status
            if (currentStatus === 'pending' || currentStatus === 'running') {
              blueprintTaskRepository.updateStatus(task.id, 'skipped')
            }
          }
        }
        this.finalizeFailed(blueprintId, workspaceId, buildPhase?.id ?? null, 'One or more build tasks failed', workspacePath)
      } else {
        // BP-BUILD-VERIFY-STARTLOCK-COLLISION: Release BUILD's pipeline lock
        // before VERIFY acquires its own. Without this, VERIFY's markPipelineRunning()
        // always throws because BUILD's startLock is still held.
        // VERIFY's finally block owns markPipelineStopped() from this point.
        blueprintService.markPipelineStopped(workspaceId)
        this.finalizeSuccess(
          blueprintId,
          workspaceId,
          workspacePath,
          buildPhase?.id ?? null,
          result,
          totalTasks
        )
        verifyTriggered = true
      }
    } catch (err) {
      bpLog.error(`[startBuildPhase] BUILD phase failed:`, err)
      // BP-WAVE-EXCEPTION-01: Mark ALL unfinished tasks as 'skipped' when wave throws.
      // Without this, tasks stuck in 'running'/'pending' permanently after an exception
      // because lines 141-151 (normal-path cleanup) were skipped.
      for (const waveNum of sortedWaves) {
        const waveTasks = waveMap.get(waveNum) ?? []
        for (const task of waveTasks) {
          const currentStatus = blueprintTaskRepository.findById(task.id)?.status
          // BP-CLEANUP-RUNNING-TASKS-01: Include 'running' — tasks marked 'running'
          // before executeTask() returned are stuck if the wave threw mid-execution.
          if (currentStatus === 'pending' || currentStatus === 'running') {
            try { blueprintTaskRepository.updateStatus(task.id, 'skipped') }
            catch { /* best effort — DB may be the cause of the original throw */ }
          }
        }
      }
      // BP-BUILD-ARTIFACT-LOSS-ON-EXCEPTION-01: Save partial artifact so build
      // progress is not silently lost when a wave throws an exception.
      if (buildPhase && result.tasksCompleted > 0) {
        try {
          const summary = this.buildArtifactSummary(
            result.tasksCompleted,
            totalTasks,
            result.filesCreated,
            result.filesModified,
            result.tasksResumed
          )
          blueprintPhaseRepository.appendArtifact(buildPhase.id, {
            type: 'build-partial',
            contentMd: `${summary}\n\n_Build interrupted by exception._`
          })
        } catch { /* best effort — DB may be the cause of the original throw */ }
      }
      this.finalizeFailed(blueprintId, workspaceId, buildPhase?.id ?? null, err instanceof Error ? err.message : String(err), workspacePath)
    } finally {
      this.activeSessions.delete(workspaceId)
      this.activeBlueprintIds.delete(workspaceId)
      // Only mark pipeline stopped if verify was NOT auto-triggered.
      // When verify is triggered, its own finally block owns markPipelineStopped()
      // to avoid destroying the AbortController that the verify phase needs.
      if (!verifyTriggered) {
        blueprintService.markPipelineStopped(workspaceId)
      }
    }
  }

  // ── Wave Execution (Parallel Scheduler) ──

  /**
   * Execute all tasks in a single wave with within-wave parallelism.
   *
   * Scheduling model: greedy in-order scan with runtime file-overlap guard.
   * - Cap read per-wave from `parallelBuildAgents` preference (1–6, default 3).
   * - Empty `filePathsJson` → exclusive task: dispatch only when inFlight empty.
   * - Failure semantics: graceful drain — no new dispatches, peers finish,
   *   unstarted → 'skipped'.
   * - Discoveries: start-time snapshot per task, merge into shared accumulator
   *   on completion (cap 20 kept).
   * - Cap 1 degenerates to today’s sequential behavior.
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
    const { waveNum, waveTasks, blueprintId, workspaceId, workspacePath, phaseContext, result } =
      params

    // Read cap per-wave from user preferences (clamped 1–6, default 3).
    const cap = appPreferenceRepository.getAppPreferences().parallelBuildAgents

    this.safeEmit('waveStart', {
      blueprintId,
      workspaceId,
      wave: waveNum,
      taskCount: waveTasks.length
    } satisfies BlueprintWaveStartPayload)

    bpLog.info(`[executeWave] Wave ${waveNum}: ${waveTasks.length} tasks, cap=${cap}`)

    // ── 1. Resume-skip already-completed tasks ──
    const pending: BlueprintTask[] = []
    let skippedCount = 0
    for (const task of waveTasks) {
      const dbTask = blueprintTaskRepository.findById(task.id)
      const effectiveStatus = dbTask?.status ?? task.status
      if (effectiveStatus === 'complete') {
        result.tasksCompleted++
        result.tasksResumed++
        skippedCount++
        bpLog.info(`[executeWave] Skipping complete task ${task.taskId} (resume)`)
        this.safeEmit('waveTaskComplete', {
          blueprintId, workspaceId, wave: waveNum,
          taskId: task.taskId, status: 'complete'
        } satisfies BlueprintWaveTaskCompletePayload)
      } else {
        pending.push(task)
      }
    }
    if (skippedCount > 0) {
      this.safeEmit('phaseProgress', {
        blueprintId, workspaceId, phase: 'build',
        text: `Skipping ${skippedCount} already-completed task${skippedCount > 1 ? 's' : ''} in Wave ${waveNum}`,
        kind: 'system'
      })
    }

    // ── 2. Parallel dispatch loop ──
    const inFlight = new Map<string, InFlightEntry>()
    let draining = false
    let pendingIdx = 0

    /** Collect all files currently in-flight. */
    const allInFlightFiles = (): Set<string> => {
      const merged = new Set<string>()
      for (const entry of inFlight.values()) {
        for (const f of entry.files) merged.add(f)
      }
      return merged
    }

    /** Update runningTasks snapshot on blueprint service (G3). */
    const syncRunningTasks = (): void => {
      const running: Record<string, { taskId: string; description: string }> = {}
      for (const [taskId, entry] of inFlight) {
        running[taskId] = { taskId, description: entry.task.description }
      }
      blueprintService.setRunningTasks(
        workspaceId,
        Object.keys(running).length > 0 ? running : null
      )
    }

    while (pendingIdx < pending.length || inFlight.size > 0) {
      // Check abort
      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      if (abortSignal?.aborted) {
        bpLog.info(`[executeWave] Aborted — draining ${inFlight.size} in-flight tasks`)
        draining = true
      }

      // ── Fill slots ──
      if (!draining) {
        let scanStart = pendingIdx
        while (inFlight.size < cap && scanStart < pending.length) {
          const task = pending[scanStart]
          const taskFiles = normalizePaths(task.filePathsJson)

          // Exclusive task (no declared files): dispatch only when inFlight is empty
          if (taskFiles.size === 0) {
            if (inFlight.size === 0) {
              // Dispatch exclusive task
              this.dispatchTask({
                task, blueprintId, workspaceId, workspacePath, phaseContext,
                result, waveNum, inFlight, taskFiles
              })
              syncRunningTasks()
              scanStart++
              pendingIdx = scanStart
              break // exclusive — no more slots this iteration
            } else {
              // Can't dispatch yet — wait for inFlight to drain
              scanStart++
              continue
            }
          }

          // File-overlap guard
          const currentFiles = allInFlightFiles()
          if (filesOverlap(taskFiles, currentFiles)) {
            scanStart++ // skip for now, try next
            continue
          }

          // Dispatch
          this.dispatchTask({
            task, blueprintId, workspaceId, workspacePath, phaseContext,
            result, waveNum, inFlight, taskFiles
          })
          syncRunningTasks()
          scanStart++
          if (scanStart === pendingIdx + 1) pendingIdx = scanStart // advance head if contiguous
        }
      }

      // ── Await first completion ──
      if (inFlight.size === 0) {
        // All remaining pending tasks were skipped by the scan (exclusive/overlap)
        // but draining is false — means no progress possible. Force sequential fallback.
        if (pendingIdx < pending.length && !draining) {
          // Advance past any skipped tasks by dispatching next one exclusively
          const nextTask = pending[pendingIdx]
          const taskFiles = normalizePaths(nextTask.filePathsJson)
          this.dispatchTask({
            task: nextTask, blueprintId, workspaceId, workspacePath, phaseContext,
            result, waveNum, inFlight, taskFiles
          })
          syncRunningTasks()
          pendingIdx++
        } else {
          break
        }
      }

      // Wait for ANY in-flight task to complete
      const settled = await Promise.race(
        [...inFlight.entries()].map(async ([taskId, entry]) => {
          const taskResult = await entry.promise
          return { taskId, entry, taskResult }
        })
      )

      // Process completion
      inFlight.delete(settled.taskId)
      this.handleTaskCompletion({
        task: settled.entry.task,
        taskResult: settled.taskResult,
        blueprintId, workspaceId, waveNum, result
      })
      syncRunningTasks()

      // Advance pendingIdx past completed tasks
      while (pendingIdx < pending.length && inFlight.has(pending[pendingIdx].taskId)) {
        pendingIdx++
      }
      // Also advance past tasks already dispatched
      while (
        pendingIdx < pending.length &&
        !inFlight.has(pending[pendingIdx].taskId) &&
        (() => {
          const s = blueprintTaskRepository.findById(pending[pendingIdx].id)?.status
          return s === 'complete' || s === 'failed'
        })()
      ) {
        pendingIdx++
      }

      // On failure → graceful drain
      if (!settled.taskResult.success && !draining) {
        bpLog.warn(`[executeWave] Task ${settled.taskId} failed — draining wave ${waveNum}`)
        draining = true
      }
    }

    // Clear running tasks
    blueprintService.setRunningTasks(workspaceId, null)

    // ── 3. Residual-risk hedge: warn if completed tasks' files overlap (undeclared writes) ──
    const completedFiles = new Map<string, Set<string>>()
    for (const task of waveTasks) {
      const dbTask = blueprintTaskRepository.findById(task.id)
      if (dbTask?.status === 'complete') {
        completedFiles.set(task.taskId, normalizePaths(task.filePathsJson))
      }
    }
    const taskIds = [...completedFiles.keys()]
    for (let i = 0; i < taskIds.length; i++) {
      for (let j = i + 1; j < taskIds.length; j++) {
        const a = completedFiles.get(taskIds[i])!
        const b = completedFiles.get(taskIds[j])!
        if (filesOverlap(a, b)) {
          const overlap = [...a].filter((f) => b.has(f))
          bpLog.warn(
            `[executeWave] OVERLAP WARNING: Tasks ${taskIds[i]} and ${taskIds[j]} ` +
            `share declared files: ${overlap.join(', ')}`
          )
        }
      }
    }

    // ── 4. Mark leftover pending as 'skipped' ──
    if (draining || result.failed) {
      for (const task of pending) {
        const currentStatus = blueprintTaskRepository.findById(task.id)?.status
        if (currentStatus === 'pending' || currentStatus === 'running') {
          blueprintTaskRepository.updateStatus(task.id, 'skipped')
          this.safeEmit('waveTaskComplete', {
            blueprintId, workspaceId, wave: waveNum,
            taskId: task.taskId, status: 'skipped'
          } satisfies BlueprintWaveTaskCompletePayload)
        }
      }
    }

    const waveFailed = draining || result.failed
    const waveStatus = waveFailed ? 'failed' : 'complete'
    this.safeEmit('waveComplete', {
      blueprintId, workspaceId, wave: waveNum, status: waveStatus
    } satisfies BlueprintWaveCompletePayload)

    if (waveFailed) {
      bpLog.warn(`[executeWave] Wave ${waveNum} failed — aborting remaining waves`)
      result.failed = true
    }
  }

  // ── Task Dispatch Helper ──

  /**
   * Dispatch a task into the in-flight set. Emits waveTaskStart, marks DB running,
   * and starts executeTask as a background promise.
   */
  private dispatchTask(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
    waveNum: number
    inFlight: Map<string, InFlightEntry>
    taskFiles: Set<string>
  }): void {
    const { task, blueprintId, workspaceId, workspacePath, phaseContext, result, waveNum, inFlight, taskFiles } = params

    this.safeEmit('waveTaskStart', {
      blueprintId, workspaceId, wave: waveNum,
      taskId: task.taskId,
      description: task.description,
      goal: buildBuildGoalCondition(task.taskId, task.description)
    } satisfies BlueprintWaveTaskStartPayload)

    blueprintTaskRepository.updateStatus(task.id, 'running')

    // Start-time snapshot of discoveries for this task
    const discoverySnapshot = [...result.discoveries]

    const promise = this.executeTask({
      task, blueprintId, workspaceId, workspacePath, phaseContext,
      priorDiscoveries: discoverySnapshot
    })

    inFlight.set(task.taskId, { promise, files: taskFiles, task })
  }

  // ── Task Completion Handler ──

  /**
   * Process a completed task: update DB, accumulate results, emit events.
   */
  private handleTaskCompletion(params: {
    task: BlueprintTask
    taskResult: { success: boolean; completion: Record<string, unknown> | null; discoveries: string[] }
    blueprintId: string
    workspaceId: string
    waveNum: number
    result: BuildResult
  }): void {
    const { task, taskResult, blueprintId, workspaceId, waveNum, result } = params

    if (taskResult.success) {
      blueprintTaskRepository.updateStatus(task.id, 'complete')
      result.tasksCompleted++
      if (taskResult.completion?.filesCreated) {
        result.filesCreated.push(...(taskResult.completion.filesCreated as string[]))
      }
      if (taskResult.completion?.filesModified) {
        result.filesModified.push(...(taskResult.completion.filesModified as string[]))
      }

      // BP-DISC-01: Accumulate per-task discoveries (merge on completion)
      if (taskResult.discoveries.length > 0) {
        result.discoveries.push(...taskResult.discoveries)
        if (result.discoveries.length > 20) {
          result.discoveries = result.discoveries.slice(-20)
        }
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.appendArtifact(buildPhase.id, {
            type: 'discoveries',
            contentJson: { phase: 'build', taskId: task.taskId, entries: taskResult.discoveries }
          })
        }
      }
    } else {
      blueprintTaskRepository.updateStatus(task.id, 'failed')
    }

    this.safeEmit('waveTaskComplete', {
      blueprintId, workspaceId, wave: waveNum,
      taskId: task.taskId,
      status: taskResult.success ? 'complete' : 'failed'
    } satisfies BlueprintWaveTaskCompletePayload)
  }

  // ── Safe Event Emission ──

  /**
   * BP-EMIT-UNHANDLED-01: Emit an event with error isolation.
   * Prevents a listener failure (e.g. renderer closed during build) from
   * crashing the wave loop. Without this, a listener throw propagates up
   * and triggers BP-WAVE-EXCEPTION-01.
   */
  private safeEmit(event: string, payload: unknown): boolean {
    try {
      return this.emit(event, payload)
    } catch (err) {
      bpLog.error(`[safeEmit] Event '${event}' listener threw:`, err)
      return false
    }
  }

  // ── Phase Finalization ──

  private finalizeFailed(
    blueprintId: string,
    workspaceId: string,
    buildPhaseId: string | null,
    error?: string,
    workspacePath?: string
  ): void {
    if (buildPhaseId) {
      blueprintPhaseRepository.updateStatus(buildPhaseId, 'failed')
    }

    // Guard: don't overwrite 'cancelled' status
    const currentStatus = blueprintRepository.findById(blueprintId)?.status
    if (currentStatus !== 'cancelled') {
      blueprintRepository.updateStatus(blueprintId, 'failed')
    }

    // M5: Use failPipeline to properly transition machine to 'failed' state
    const errorMsg = error ?? 'Build phase failed'
    blueprintService.failPipeline(workspaceId, errorMsg)

    const autoRetrying = workspacePath
      ? blueprintService.scheduleAutoRetry({
          blueprintId, workspaceId, workspacePath, phase: 'build', error: errorMsg
        })
      : false

    // BP-BUILD-FINALIZE-RAW-EMIT-01: Use safeEmit to prevent listener throws
    // from crashing the catch handler or creating a double-call loop.
    this.safeEmit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'build',
      status: 'failed',
      error,
      ...(autoRetrying ? { autoRetry: true } : {})
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

    bpLog.info(
      `[finalizeSuccess] Blueprint ${blueprintId} — build complete (${result.tasksCompleted}/${totalTasks} tasks), advancing to VERIFY`
    )

    // BP-BUILD-FINALIZE-RAW-EMIT-01: Use safeEmit to prevent listener throws
    // from propagating through finalizeSuccess into the catch handler.
    this.safeEmit('phaseComplete', {
      blueprintId,
      workspaceId,
      phase: 'build',
      status: 'complete',
      completion: {
        phase: 'build',
        status: 'complete',
        tasksCompleted: result.tasksCompleted,
        totalTasks,
        filesCreated: result.filesCreated,
        filesModified: result.filesModified
      }
    } satisfies BlueprintPhaseCompletePayload)

    this.safeEmit('phaseArtifact', {
      blueprintId,
      workspaceId,
      phase: 'build',
      artifact: {
        type: 'build',
        contentMd: this.buildArtifactSummary(
          result.tasksCompleted,
          totalTasks,
          result.filesCreated,
          result.filesModified,
          result.tasksResumed
        )
      }
    } satisfies BlueprintPhaseArtifactPayload)

    // Auto-trigger VERIFY phase (non-blocking).
    // BP-VERIFY-AUTOFIRE-01: M6 wire-once pattern means listeners are always active.
    // No per-workspace wiring needed.
    // BP-VERIFY-SYNC-01: Wrap in try-catch for synchronous throws (e.g. markPipelineRunning()
    // throwing if lock is held). .catch() only handles Promise rejections, not sync throws
    // that occur before the Promise is returned.
    try {
      blueprintVerifyService
        .startVerifyPhase({
          blueprintId,
          workspaceId,
          workspacePath
        })
        .catch((err) => {
          bpLog.error('[build→verify] Verify phase failed:', err)
          // BP-02: If verify rejects, pipeline is never marked stopped.
          // Clean up here so the workspace isn't permanently locked.
          const errorMsg = err instanceof Error ? err.message : String(err)
          blueprintService.failPipeline(workspaceId, errorMsg)
          blueprintRepository.updateStatus(blueprintId, 'failed')
        })
    } catch (syncErr) {
      bpLog.error('[build→verify] Verify startup failed (sync):', syncErr)
      const errorMsg = syncErr instanceof Error ? syncErr.message : String(syncErr)
      blueprintService.failPipeline(workspaceId, errorMsg)
      blueprintRepository.updateStatus(blueprintId, 'failed')
    }
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
    priorDiscoveries: string[]
  }): Promise<{ success: boolean; completion: Record<string, unknown> | null; discoveries: string[] }> {
    const { task, blueprintId, workspaceId, workspacePath, phaseContext } = params

    bpLog.info(`[executeTask] Task ${task.taskId}: ${task.description.slice(0, 80)}`)

    // Build task-specific context string (with accumulated discoveries from prior tasks)
    const taskContext = this.buildTaskContext(task, params.priorDiscoveries)

    // Create adapter + session
    const adapter = new BlueprintBuildAdapter({
      workspaceId,
      blueprintId,
      phaseContext,
      taskContext
    })
    adapter.setGoalCondition(buildBuildGoalCondition(task.taskId, task.description), 'enforce')

    // G1: Per-task instanceId for MCP config file isolation
    const instanceId = `build-${task.taskId}-${Date.now()}`
    const session = new AgentSessionService(adapter, instanceId)

    // Set-based session tracking (multiple parallel tasks per workspace)
    let sessionSet = this.activeSessions.get(workspaceId)
    if (!sessionSet) {
      sessionSet = new Set()
      this.activeSessions.set(workspaceId, sessionSet)
    }
    sessionSet.add(session)

    // Wire streaming — forward progress events + stall watchdog
    // BP-BUILD-TASK-RAW-EMIT-01: safeEmit prevents listener throws from
    // crashing the streaming loop during task execution.
    const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, `BUILD-${task.taskId}`)

    const onChunk = (chunk: StreamChunk): void => {
      stallWatchdog.touch()
      forwardBlueprintChunk(
        (event, payload) => this.safeEmit(event, payload),
        chunk,
        { blueprintId, workspaceId, phase: 'build', workspacePath, mode: 'build', taskId: task.taskId }
      )
    }
    // G2: Per-task status — derive workspace status from all active tasks
    const onStatus = (status: AgentStatus): void => {
      this.perTaskStatus.set(task.taskId, status.status)
      // Derive: busy if any task is busy, idle only when all drained
      const allStatuses = [...this.perTaskStatus.values()]
      const derivedStatus = allStatuses.some((s) => s === 'busy') ? 'busy' : 'idle'
      this.safeEmit('status', { workspaceId, status: { ...status, status: derivedStatus } })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    // B4-FIX: Auto-respond to ask_user calls — build is non-interactive
    const cleanupAskUser = wireAskUserAutoResponder(session, 'BUILD')

    try {
      // Start session in BUILD mode (write access)
      await session.start(workspacePath, 'build')

      const syntheticConvId = `blueprint-build-${blueprintId}-${task.taskId}-${Date.now()}`

      // Race: send vs timeout vs abort
      let timeoutId: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<void>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`Task ${task.taskId} timeout`)),
          TASK_TIMEOUT_MS
        )
      })

      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      // BP-ABORT-TOCTOU-01: Attach listener BEFORE checking aborted status to
      // close the race window where the signal fires between check and addEventListener.
      // BP-ABORT-LISTENER-LEAK-01: Hoist handler so it can be removed in finally.
      let abortHandler: (() => void) | undefined
      const abortPromise = new Promise<void>((_, reject) => {
        abortHandler = (): void => reject(new Error('Phase cancelled'))
        abortSignal?.addEventListener('abort', abortHandler, { once: true })
        if (abortSignal?.aborted) {
          abortHandler()
        }
      })

      const sendPromise = session.send(adapter.getPhaseMessage(), syntheticConvId)

      try {
        await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        stallWatchdog.dispose()
        // BP-ABORT-LISTENER-LEAK-01: Clean up abort listener if task completed normally
        if (abortHandler) abortSignal?.removeEventListener('abort', abortHandler)
      }

      // Parse output
      const text = session.getStreamedContent()
      const completion = parsePhaseCompletionBlock(text, 'build') ?? null

      if (!completion && text.length > 200) {
        bpLog.warn(`[executeTask] Task ${task.taskId}: no completion block in ${text.length}-char output`)
      }
      bpLog.info(
        `[executeTask] Task ${task.taskId} complete — status: ${completion?.status ?? 'unknown'}`
      )

      // Parse discoveries block from task output
      const taskDiscoveries = parseDiscoveriesBlock(text) ?? []

      return { success: true, completion, discoveries: taskDiscoveries }
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

      return { success: false, completion: null, discoveries: [] }
    } finally {
      cleanupAskUser()
      session.removeListener('chunk', onChunk)
      session.removeListener('statusUpdate', onStatus)
      // BP-SESSION-LEAK-01: Wrap session.stop() in its own try-catch so a stop()
      // failure doesn't skip activeSessions cleanup, causing a resource leak.
      try {
        await session.stop()
      } catch (stopErr) {
        bpLog.error(`[executeTask] session.stop() failed for task ${task.taskId}:`, stopErr)
      }
      const sessions = this.activeSessions.get(workspaceId)
      if (sessions) {
        sessions.delete(session)
        if (sessions.size === 0) this.activeSessions.delete(workspaceId)
      }
      this.perTaskStatus.delete(task.taskId)
    }
  }

  // ── Task Context Builder ──

  /**
   * Format a BlueprintTask into a context string for the adapter.
   * Includes task ID, description, file paths, user story, and dependencies.
   */
  private buildTaskContext(task: BlueprintTask, priorDiscoveries?: string[]): string {
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

    // BP-DISC-02: Thread accumulated discoveries into task context
    if (priorDiscoveries?.length) {
      lines.push('')
      lines.push('**Discoveries from earlier tasks**:')
      for (const d of priorDiscoveries.slice(-20)) {
        lines.push(`- ${d}`)
      }
    }

    return lines.join('\n')
  }

  // ── Artifact Summary ──

  private buildArtifactSummary(
    tasksCompleted: number,
    totalTasks: number,
    filesCreated: string[],
    filesModified: string[],
    tasksResumed?: number
  ): string {
    let taskLine = `**Tasks**: ${tasksCompleted}/${totalTasks} completed`
    if (tasksResumed && tasksResumed > 0) {
      taskLine += ` (${tasksResumed} resumed from prior run)`
    }
    const lines = [
      `# Build Phase Summary`,
      '',
      taskLine,
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
    // BP-05: Find the workspace whose active blueprint matches
    for (const [wsId, bpId] of this.activeBlueprintIds) {
      if (bpId === blueprintId) {
        const sessions = this.activeSessions.get(wsId)
        if (sessions) {
          bpLog.info(`[cancelBlueprint] Stopping ${sessions.size} active session(s) for blueprint ${blueprintId}`)
          for (const session of sessions) {
            try { await session.stop() } catch { /* best effort */ }
          }
          this.activeSessions.delete(wsId)
          this.activeBlueprintIds.delete(wsId)
        }
        break
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const [wsId, sessions] of this.activeSessions) {
      for (const session of sessions) {
        try { await session.stop() } catch { /* best effort */ }
      }
      this.activeBlueprintIds.delete(wsId)
    }
    this.activeSessions.clear()
    this.activeBlueprintIds.clear()
  }
}

export const blueprintBuildService = new BlueprintBuildService()
