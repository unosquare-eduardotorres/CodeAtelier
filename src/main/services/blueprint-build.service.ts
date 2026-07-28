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
import { parsePhaseCompletionBlock, parseDiscoveriesBlock, asStringArray } from './blueprint-artifact-parsers'
import { verifyTaskFileClaims } from './blueprint-task-verification'
import { blueprintService } from './blueprint.service'
import { codeGraphService } from './code-graph.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'
import { runPreflightChecks, buildPreflightDiscoveries } from './blueprint-preflight.service'

const bpLog = log.scope('blueprint-build')

const TASK_TIMEOUT_MS = 30 * 60_000 // 30 min per task

// ── Overload retry constants ──
const OVERLOAD_MAX_RETRIES = 2 // 3 total attempts per task
const OVERLOAD_BACKOFF_BASE_MS = 60_000 // 60s, then 120s (exponential)

/** Matches evidence-only / re-run-verify task descriptions for soft-pass gating. Exported for tests (GAP-5). */
export const EVIDENCE_ONLY_RX = /\bre-?run\b.*\b(verify|verification)\b|\bverif\w+ (pass|evidence)\b|\bevidence.*(eslint|tsc|vitest|complexity|dead.?code)/i

/**
 * Abort-aware sleep: resolves after `ms` OR rejects immediately if the signal
 * fires — so Cancel works during the backoff wait. Clears its timer on abort
 * to avoid leaked timeouts.
 */
export function abortAwareSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Per-task timing breakdown for build performance instrumentation. */
export interface TaskTiming {
  taskId: string
  wave: number
  tDispatch: number       // When dispatchTask was called
  tSessionReady: number   // session.start() resolved
  tFirstChunk: number     // First stream chunk received (prefill latency proxy)
  tComplete: number       // session.send() promise settled
  tSlotFreed: number      // Task promise resolved (slot available for next dispatch)
  durationMs: number      // tSlotFreed - tDispatch (total wall time)
}

/** Mutable accumulator passed through wave/task execution. */
interface BuildResult {
  tasksCompleted: number
  tasksResumed: number
  filesCreated: string[]
  filesModified: string[]
  failed: boolean
  /** Accumulated discoveries from all completed build tasks (capped at 20). */
  discoveries: string[]
  /** Phase 0: Per-task timing data for build performance analysis. */
  taskTimings: TaskTiming[]
  /** Per-task failure summaries for UI surfacing instead of generic message. */
  taskFailures: Array<{ taskId: string; reason: string }>
}

/** Return type for executeTask, including timing data. */
interface TaskResult {
  success: boolean
  completion: Record<string, unknown> | null
  discoveries: string[]
  timing?: TaskTiming
  /** When success=false, the reason for failure (session outcome or 'no-write-activity'). */
  failureReason?: string
}

/** In-flight task metadata for the parallel scheduler. */
interface InFlightEntry {
  promise: Promise<TaskResult>
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
      discoveries: [],
      taskTimings: [],
      taskFailures: []
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

      // D11: Preflight discovery injection — BEFORE verify-gap seeding so verify
      // gaps survive the 20-cap slice (A9 fix: verify gaps take priority over preflight warns).
      try {
        const pfTasks = blueprintTaskRepository.findByBlueprint(blueprintId)
        const pfTaskDescriptions = pfTasks.map((t) => t.description)
        const preflightResult = await runPreflightChecks(workspacePath, pfTaskDescriptions)

        if (preflightResult.hasBlockers || preflightResult.hasWarnings) {
          const currentBp = blueprintRepository.findById(blueprintId)
          const preflightOverride = (currentBp?.settingsJson as Record<string, unknown>)?.preflightOverride as boolean | undefined
          bpLog.warn(
            `[startBuildPhase] Preflight: ${preflightResult.checks.filter((c) => c.status === 'blocker').length} blockers, ` +
            `${preflightResult.checks.filter((c) => c.status === 'warn').length} warnings` +
            (preflightOverride ? ' (override in effect)' : '')
          )

          // D11: Only blockers injected as discoveries (warns excluded to avoid crowding)
          const preflightDiscoveries = buildPreflightDiscoveries(preflightResult)
          if (preflightDiscoveries.length > 0) {
            result.discoveries.push(...preflightDiscoveries)
            if (result.discoveries.length > 20) {
              result.discoveries = result.discoveries.slice(-20)
            }
          }

          // Emit phaseProgress warning for UI visibility
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: `⚠ Environment preflight: ${preflightResult.checks.filter((c) => c.status === 'blocker').length} blockers, ${preflightResult.checks.filter((c) => c.status === 'warn').length} warnings`,
            kind: 'text'
          })
        } else {
          bpLog.info(`[startBuildPhase] Preflight: all checks pass`)
        }
      } catch (preflightErr) {
        // Preflight failure never blocks build (premortem #4)
        bpLog.warn(`[startBuildPhase] Preflight re-check failed (non-fatal):`, preflightErr)
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
                if (!f || typeof f !== 'object') continue
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
      // Phase 0: Log aggregate timing per-wave
      if (result.taskTimings.length > 0) {
        const avgDuration = result.taskTimings.reduce((s, t) => s + t.durationMs, 0) / result.taskTimings.length
        const avgSpawn = result.taskTimings
          .filter((t) => t.tSessionReady > 0)
          .map((t) => t.tSessionReady - t.tDispatch)
        const avgPrefill = result.taskTimings
          .filter((t) => t.tFirstChunk > 0 && t.tSessionReady > 0)
          .map((t) => t.tFirstChunk - t.tSessionReady)
        const avgLlm = result.taskTimings
          .filter((t) => t.tComplete > 0 && t.tFirstChunk > 0)
          .map((t) => t.tComplete - t.tFirstChunk)
        bpLog.info(
          `[startBuildPhase] TIMING: ${result.taskTimings.length} tasks, ` +
          `avg total=${Math.round(avgDuration)}ms, ` +
          `avg spawn=${avgSpawn.length ? Math.round(avgSpawn.reduce((a, b) => a + b, 0) / avgSpawn.length) : '?'}ms, ` +
          `avg prefill=${avgPrefill.length ? Math.round(avgPrefill.reduce((a, b) => a + b, 0) / avgPrefill.length) : '?'}ms, ` +
          `avg llm=${avgLlm.length ? Math.round(avgLlm.reduce((a, b) => a + b, 0) / avgLlm.length) : '?'}ms`
        )
      }

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
            filesModified: result.filesModified,
            taskTimings: result.taskTimings
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
        // BP-TASK-FAILURE-REASON: Build per-task failure summary for UI surfacing
        const failureSummary = result.taskFailures.length > 0
          ? result.taskFailures.map((f) => `${f.taskId}: ${f.reason}`).join('; ')
          : 'One or more build tasks failed'
        // BP-RETRY-CONTEXT: Save structured retry context with files/task progress
        try {
          blueprintService.saveRetryContext(blueprintId, 'build', {
            error: failureSummary,
            filesModified: result.filesModified,
            filesCreated: result.filesCreated,
            tasksCompleted: result.tasksCompleted,
            totalTasks
          })
        } catch { /* best effort */ }
        this.finalizeFailed(blueprintId, workspaceId, buildPhase?.id ?? null, failureSummary, workspacePath)
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
      // BP-RETRY-CONTEXT: Save structured retry context with files/task progress
      try {
        blueprintService.saveRetryContext(blueprintId, 'build', {
          error: err instanceof Error ? err.message : String(err),
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          tasksCompleted: result.tasksCompleted,
          totalTasks
        })
      } catch { /* best effort */ }
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
    // FIX-4: Made mutable — halved on overload to reduce API pressure.
    let cap = appPreferenceRepository.getAppPreferences().parallelBuildAgents

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
    // C3 FIX: Track dispatched tasks to prevent re-dispatch of out-of-order completions.
    const dispatched = new Set<string>()
    // C4 FIX: When an exclusive task (empty filePathsJson) is in-flight, block all
    // further dispatches. Its empty file set makes allInFlightFiles() empty, which
    // would otherwise allow peers to dispatch alongside it.
    let exclusiveInFlight = false
    // H2 FIX: Collect *reported* filesModified per task (from completion result)
    // for post-wave overlap detection. Declared filePathsJson misses undeclared writes.
    const reportedFiles = new Map<string, Set<string>>()
    // OVERLOAD-RETRY: Per-task retry counter for overload backoff.
    const overloadRetries = new Map<string, number>()

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
      if (!draining && !exclusiveInFlight) {
        let scanStart = pendingIdx
        while (inFlight.size < cap && scanStart < pending.length) {
          const task = pending[scanStart]

          // C3 FIX: Skip already-dispatched tasks (prevents re-dispatch when
          // out-of-order completions leave pendingIdx behind a completed task).
          if (dispatched.has(task.taskId)) {
            scanStart++
            if (scanStart === pendingIdx + 1) pendingIdx = scanStart
            continue
          }

          // C3 FIX: Dispatch-time DB status check (BP-RESUME-01 preserved).
          // A task may have been completed by an earlier wave iteration or external
          // resume — skip it rather than re-executing. Failed tasks are NOT skipped
          // here so that retry/resume can re-execute them (wave resume filter at
          // line ~412 deliberately pushes failed tasks into pending).
          const dbStatus = blueprintTaskRepository.findById(task.id)?.status
          if (dbStatus === 'complete') {
            dispatched.add(task.taskId)
            scanStart++
            if (scanStart === pendingIdx + 1) pendingIdx = scanStart
            continue
          }

          const taskFiles = normalizePaths(task.filePathsJson)

          // Exclusive task (no declared files): dispatch only when inFlight is empty
          if (taskFiles.size === 0) {
            if (inFlight.size === 0) {
              // Dispatch exclusive task
              this.dispatchTask({
                task, blueprintId, workspaceId, workspacePath, phaseContext,
                result, waveNum, inFlight, taskFiles
              })
              dispatched.add(task.taskId)
              // C4 FIX: Block all further dispatches while exclusive task runs.
              exclusiveInFlight = true
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
          dispatched.add(task.taskId)
          syncRunningTasks()
          scanStart++
          if (scanStart === pendingIdx + 1) pendingIdx = scanStart // advance head if contiguous
        }
      }

      // ── Await first completion ──
      if (inFlight.size === 0) {
        // All remaining pending tasks were skipped by the scan (exclusive/overlap)
        // but draining is false — means no progress possible. Force sequential fallback.
        // Skip past already-dispatched tasks first.
        while (pendingIdx < pending.length && dispatched.has(pending[pendingIdx].taskId)) {
          pendingIdx++
        }
        if (pendingIdx < pending.length && !draining) {
          // Advance past any skipped tasks by dispatching next one exclusively
          const nextTask = pending[pendingIdx]
          const taskFiles = normalizePaths(nextTask.filePathsJson)
          this.dispatchTask({
            task: nextTask, blueprintId, workspaceId, workspacePath, phaseContext,
            result, waveNum, inFlight, taskFiles
          })
          dispatched.add(nextTask.taskId)
          if (taskFiles.size === 0) exclusiveInFlight = true
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
      // C4 FIX: Clear exclusive flag when the exclusive task completes.
      if (settled.entry.files.size === 0) {
        exclusiveInFlight = false
      }

      // ── OVERLOAD-RETRY: Intercept overload failures before handleTaskCompletion ──
      // If the task failed with 'overload' and retries remain, re-insert it into
      // inFlight with a delayed re-dispatch instead of marking it failed.
      if (
        !settled.taskResult.success &&
        settled.taskResult.failureReason === 'overload' &&
        !draining &&
        !abortSignal?.aborted
      ) {
        const priorRetries = overloadRetries.get(settled.taskId) ?? 0
        if (priorRetries < OVERLOAD_MAX_RETRIES) {
          const attempt = priorRetries + 1
          overloadRetries.set(settled.taskId, attempt)
          const delay = OVERLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)

          // FIX-4: Cap-halving still applies on first overload per task
          if (priorRetries === 0 && cap > 1) {
            const newCap = Math.max(1, Math.floor(cap / 2))
            bpLog.warn(
              `[executeWave] Task ${settled.taskId} hit API overload — ` +
              `reducing parallel cap from ${cap} to ${newCap}`
            )
            cap = newCap
          }

          const totalAttempts = OVERLOAD_MAX_RETRIES + 1
          bpLog.info(
            `[executeWave] Task ${settled.taskId} overload retry ${attempt + 1}/${totalAttempts} ` +
            `— backing off ${delay / 1000}s`
          )
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: `⚠ Task ${settled.entry.task.taskId} hit API overload — ` +
              `retrying in ${delay / 1000}s (attempt ${attempt + 1}/${totalAttempts})`,
            kind: 'system'
          })

          // Build a delayed re-dispatch promise. The sleeping task occupies a slot
          // during backoff (deliberate — reduces API pressure).
          const retryTask = settled.entry.task
          const retryFiles = settled.entry.files
          const discoverySnapshot = [...result.discoveries]
          const retryPromise = abortAwareSleep(delay, abortSignal ?? undefined)
            .then(() =>
              this.executeTask({
                task: retryTask,
                blueprintId,
                workspaceId,
                workspacePath,
                phaseContext,
                priorDiscoveries: discoverySnapshot,
                tDispatch: Date.now(), // Fresh tDispatch for mtime-freshness check
                waveNum
              })
            )
            .catch((_err): TaskResult => {
              // Abort during sleep → treat as failed (flows into drain path)
              return {
                success: false,
                completion: null,
                discoveries: [],
                failureReason: 'aborted'
              }
            })

          // TIMING-FIX: Preserve the failed attempt's timing in the aggregate.
          // handleTaskCompletion is skipped for retried tasks, so without this
          // the intermediate attempt vanishes from result.taskTimings.
          if (settled.taskResult.timing) {
            result.taskTimings.push(settled.taskResult.timing)
          }

          // Re-mark task as running in DB (it was never marked failed)
          blueprintTaskRepository.updateStatus(retryTask.id, 'running')
          inFlight.set(settled.taskId, {
            promise: retryPromise,
            files: retryFiles,
            task: retryTask
          })
          // Restore exclusive flag if this was an exclusive task
          if (retryFiles.size === 0) exclusiveInFlight = true
          syncRunningTasks()
          continue // Skip handleTaskCompletion — task stays in-flight
        }
        // Retries exhausted: fall through to handleTaskCompletion + drain
      }

      this.handleTaskCompletion({
        task: settled.entry.task,
        taskResult: settled.taskResult,
        blueprintId, workspaceId, waveNum, result
      })

      // H2 FIX: Collect reported filesModified for post-wave overlap detection.
      // R2 FIX: Guard via asStringArray — LLM may emit a string, object, or mixed array.
      if (settled.taskResult.success) {
        const modified = asStringArray(settled.taskResult.completion?.filesModified)
        if (modified.length > 0) {
          reportedFiles.set(settled.taskId, normalizePaths(modified))
        }
      }
      syncRunningTasks()

      // Advance pendingIdx past dispatched/completed tasks
      while (
        pendingIdx < pending.length &&
        (dispatched.has(pending[pendingIdx].taskId) || inFlight.has(pending[pendingIdx].taskId))
      ) {
        pendingIdx++
      }

      // On failure → graceful drain
      if (!settled.taskResult.success && !draining) {
        // FIX-4: On overload with retries exhausted, drain the wave — the task has
        // been retried OVERLOAD_MAX_RETRIES times and keeps failing.
        if (settled.taskResult.failureReason === 'overload') {
          const totalAttempts = OVERLOAD_MAX_RETRIES + 1
          bpLog.warn(
            `[executeWave] Task ${settled.taskId} overload retries exhausted — ` +
            `draining wave ${waveNum}`
          )
          // DEDUP-FIX: Terminal overload message — executeTask no longer emits for
          // overload, so this is the only UI message for a permanently-failed task.
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: `⚠ Task ${settled.entry.task.taskId} failed after ${totalAttempts} attempts ` +
              `due to API overload — stopping build`,
            kind: 'system'
          })
          draining = true
        } else {
          bpLog.warn(`[executeWave] Task ${settled.taskId} failed — draining wave ${waveNum}`)
          draining = true
        }
      }
    }

    // Clear running tasks
    blueprintService.setRunningTasks(workspaceId, null)

    // ── 3. Residual-risk hedge: warn if completed tasks' reported files overlap ──
    // H2 FIX: Compare *reported* filesModified (actual writes) instead of declared
    // filePathsJson. Declared files are already serialized by the scheduler, so
    // overlaps there are intentional. Undeclared writes are the real risk.
    const taskIdsForOverlap = [...reportedFiles.keys()]
    for (let i = 0; i < taskIdsForOverlap.length; i++) {
      for (let j = i + 1; j < taskIdsForOverlap.length; j++) {
        const a = reportedFiles.get(taskIdsForOverlap[i])!
        const b = reportedFiles.get(taskIdsForOverlap[j])!
        if (filesOverlap(a, b)) {
          const overlap = [...a].filter((f) => b.has(f))
          bpLog.warn(
            `[executeWave] REPORTED FILE OVERLAP: Tasks ${taskIdsForOverlap[i]} and ${taskIdsForOverlap[j]} ` +
            `both modified: ${overlap.join(', ')}`
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

    // Phase 0: Record dispatch timestamp
    const tDispatch = Date.now()

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
      priorDiscoveries: discoverySnapshot,
      tDispatch,
      waveNum
    })

    inFlight.set(task.taskId, { promise, files: taskFiles, task })
  }

  // ── Task Completion Handler ──

  /**
   * Process a completed task: update DB, accumulate results, emit events.
   */
  private handleTaskCompletion(params: {
    task: BlueprintTask
    taskResult: TaskResult
    blueprintId: string
    workspaceId: string
    waveNum: number
    result: BuildResult
  }): void {
    const { task, taskResult, blueprintId, workspaceId, waveNum, result } = params

    // Phase 0: Collect timing
    if (taskResult.timing) {
      result.taskTimings.push(taskResult.timing)
    }

    if (taskResult.success) {
      blueprintTaskRepository.updateStatus(task.id, 'complete')
      result.tasksCompleted++
      // A1 FIX: Coerce via asStringArray — LLM completion is unvalidated Record<string, unknown>.
      const created = asStringArray(taskResult.completion?.filesCreated)
      if (created.length > 0) result.filesCreated.push(...created)
      const modified = asStringArray(taskResult.completion?.filesModified)
      if (modified.length > 0) result.filesModified.push(...modified)

      // Persist per-task completion data so the verify-phase disk check can
      // distinguish claimed files (hard failure) from planned-but-not-claimed
      // files (drift — informational only).
      blueprintTaskRepository.setCompletion(task.id, {
        filesCreated: created,
        filesModified: modified
      })

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
      // BP-TASK-FAILURE-REASON: Collect per-task failure reasons for UI surfacing
      result.taskFailures.push({
        taskId: task.taskId,
        reason: taskResult.failureReason ?? 'unknown'
      })
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
      // BP-RETRY-CONTEXT-CLEAR: Clear retry context on successful completion
      const buildPhaseRec = blueprintPhaseRepository.findById(buildPhaseId)
      if (buildPhaseRec?.contextSnapshot) {
        blueprintPhaseRepository.saveContextSnapshot(buildPhaseId, null)
      }
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
    tDispatch: number
    waveNum: number
  }): Promise<TaskResult> {
    const { task, blueprintId, workspaceId, workspacePath, phaseContext, tDispatch, waveNum } = params

    // Phase 0: Timing instrumentation
    let tSessionReady = 0
    let tFirstChunk = 0
    let tComplete = 0

    bpLog.info(`[executeTask] Task ${task.taskId}: ${task.description.slice(0, 80)}`)

    // BP-RETRY-TASK-CONTEXT: Check for prior build-partial artifact for this specific task.
    // Use word-boundary regex to avoid substring collisions (e.g., T1 matching T10/T11).
    // Use findLast() to get the most recent partial if multiple retries accumulated.
    const buildPhaseRec = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
    const taskIdPattern = new RegExp(`\\bTask ${task.taskId}\\b`)
    const priorPartial = buildPhaseRec?.artifactsJson.findLast(
      (a) => a.type === 'build-partial' && a.contentMd != null && taskIdPattern.test(a.contentMd)
    )

    // Build task-specific context string (with accumulated discoveries + prior attempt output)
    const taskContext = this.buildTaskContext(task, params.priorDiscoveries, priorPartial?.contentMd)

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

    // FIX-2: Track write-capable tool calls to detect no-op sessions whose
    // stale files on disk would otherwise pass the disk-existence check.
    const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
    let writeToolCalls = 0
    let bashCalls = 0

    const onChunk = (chunk: StreamChunk): void => {
      // Phase 0: Record first chunk time (prefill latency proxy)
      if (tFirstChunk === 0) tFirstChunk = Date.now()
      stallWatchdog.touch()

      // FIX-2: Count write-capable tool invocations
      if (chunk.type === 'tool_use' && chunk.toolName) {
        if (WRITE_TOOLS.has(chunk.toolName)) writeToolCalls++
        if (chunk.toolName === 'Bash') bashCalls++
      }

      forwardBlueprintChunk(
        (event, payload) => this.safeEmit(event, payload),
        chunk,
        { blueprintId, workspaceId, phase: 'build', workspacePath, mode: 'build', taskId: task.taskId }
      )
    }
    // G2: Per-task status — derive workspace status from all active tasks
    // H4 FIX: Key by workspaceId:taskId to prevent cross-workspace collisions
    // when two workspaces build concurrently.
    const statusKey = `${workspaceId}:${task.taskId}`
    const onStatus = (status: AgentStatus): void => {
      this.perTaskStatus.set(statusKey, status.status)
      // Derive: busy if any task for THIS workspace is busy, idle only when all drained
      const wsPrefix = `${workspaceId}:`
      const wsStatuses = [...this.perTaskStatus.entries()]
        .filter(([k]) => k.startsWith(wsPrefix))
        .map(([, v]) => v)
      const derivedStatus = wsStatuses.some((s) => s !== 'idle' && s !== 'completed' && s !== 'failed') ? 'busy' : 'idle'
      this.safeEmit('status', { workspaceId, status: { ...status, status: derivedStatus } })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    // B4-FIX: Auto-respond to ask_user calls — build is non-interactive
    const cleanupAskUser = wireAskUserAutoResponder(session, 'BUILD')

    let taskResult: TaskResult = { success: false, completion: null, discoveries: [] }

    try {
      // Start session in BUILD mode (write access)
      await session.start(workspacePath, 'build')
      tSessionReady = Date.now()

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

      // Phase 0: Mark LLM completion time
      tComplete = Date.now()

      // FIX-1: Check session outcome — handleStreamError absorbs terminal errors
      // (overload, turn_limit_exhausted, context_overflow, generic error) and resolves
      // send() cleanly. Without this check, a no-op session appears successful.
      const sendOutcome = session.getLastSendOutcome()
      if (sendOutcome !== 'ok') {
        bpLog.error(
          `[executeTask] Task ${task.taskId} FAILED — session ended with outcome: ${sendOutcome}`
        )
        // DEDUP-FIX: Skip UI message for overload — the scheduler owns overload
        // messaging (retry message on retryable, terminal message on exhaustion).
        if (sendOutcome !== 'overload') {
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: `⚠ Task ${task.taskId} FAILED — session ended with ${sendOutcome}`,
            kind: 'system'
          })
        }
        taskResult = { success: false, completion: null, discoveries: [], failureReason: sendOutcome }
      } else {
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

      // BP-VERIFY-TASK-FILES-01: Deterministic disk verification — never trust unverified claims.
      // Check that files the LLM claimed to create/modify actually exist on disk.
      // FIX-3: Pass tDispatch as taskStartedAt for mtime freshness checking.
      const verification = verifyTaskFileClaims(workspacePath, completion, task.filePathsJson, tDispatch)

      // BP-EVIDENCE-ONLY-SOFTPASS: Defense-in-depth for verification/evidence-only tasks.
      // When verification fails with stale-only or no-fresh-file (no files actually absent)
      // AND the task description matches a verification/evidence pattern, soft-pass it.
      // These tasks (e.g. "Re-run the full verify pass with evidence") modify no files
      // by design, so the mtime-freshness net always rejects them. The remediation loop
      // already re-runs verify — a build-wave verify task is redundant.
      // GAP-4 FIX: Dropped bare `run` alternative — only match `re-run`/`rerun` to
      // avoid false soft-pass on tasks like "Run migrations and verify schema".
      // Regex exported at module level as EVIDENCE_ONLY_RX (GAP-5).
      const isEvidenceOnlyTask =
        !verification.ok &&
        verification.missingClaimed.length === 0 &&
        verification.missingPlanned.length === 0 &&
        EVIDENCE_ONLY_RX.test(task.description)

      if (isEvidenceOnlyTask) {
        bpLog.warn(
          `[executeTask] Task ${task.taskId} verification soft-pass — ` +
          `evidence-only task with ${verification.staleClaimed.length} stale file(s), ` +
          `no missing files. Description: "${task.description.slice(0, 120)}"`
        )
        // Append a warning artifact (not failure) so it's visible in Deliverables
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.appendArtifact(buildPhase.id, {
            type: 'verification-warning',
            contentMd:
              `## Task ${task.taskId} — verification soft-pass (evidence-only)\n\n` +
              `This task is a verification/evidence-gathering task that modifies no files by design.\n` +
              `The file-freshness check found ${verification.staleClaimed.length} stale file(s) but ` +
              `no files are actually missing — treated as passed with warning.\n\n` +
              (verification.staleClaimed.length > 0
                ? `**Stale files (${verification.staleClaimed.length}):**\n` +
                  verification.staleClaimed.map((f) => `- \`${f}\``).join('\n') + '\n'
                : '')
          })
        }
        taskResult = { success: true, completion, discoveries: taskDiscoveries }
      } else if (!verification.ok) {
        const n = asStringArray(completion?.filesCreated).length + asStringArray(completion?.filesModified).length
        const missingList = verification.missingClaimed.length > 0
          ? verification.missingClaimed
          : verification.missingPlanned
        bpLog.error(
          `[executeTask] Task ${task.taskId} FAILED verification — ` +
          `${verification.missingClaimed.length} claimed missing, ` +
          `${verification.staleClaimed.length} stale, ` +
          `${verification.missingPlanned.length} planned missing: ` +
          `${missingList.slice(0, 10).join(', ')}${missingList.length > 10 ? ` (+${missingList.length - 10} more)` : ''}`
        )

        // Append artifact so the discrepancy is visible in Deliverables
        const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        if (buildPhase) {
          blueprintPhaseRepository.appendArtifact(buildPhase.id, {
            type: 'verification-failure',
            contentMd:
              `## Task ${task.taskId} — claimed files missing on disk\n\n` +
              (verification.missingClaimed.length > 0
                ? `**Claimed but absent (${verification.missingClaimed.length}):**\n` +
                  verification.missingClaimed.map((f) => `- \`${f}\``).join('\n') + '\n\n'
                : '') +
              (verification.staleClaimed.length > 0
                ? `**Claimed but stale (${verification.staleClaimed.length}):**\n` +
                  verification.staleClaimed.map((f) => `- \`${f}\``).join('\n') + '\n\n'
                : '') +
              (verification.missingPlanned.length > 0
                ? `**Planned but absent (${verification.missingPlanned.length}):**\n` +
                  verification.missingPlanned.map((f) => `- \`${f}\``).join('\n') + '\n'
                : '')
          })
        }

        // Surface to UI via existing phaseProgress channel (system message)
        // GAP-2 FIX: Include stale-aware branch so the message reflects the real reason
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text: `⚠ Task ${task.taskId} marked FAILED — ` +
            (verification.missingClaimed.length > 0
              ? `claimed ${n} file(s), ${verification.missingClaimed.length} missing on disk`
              : verification.staleClaimed.length > 0
                ? `${verification.staleClaimed.length} claimed file(s) stale on disk`
                : `no output files found (${verification.missingPlanned.length} planned files absent)`),
          kind: 'system'
        })

        // Append missingPlanned (non-fatal) to discoveries so subsequent waves see the drift
        if (verification.missingPlanned.length > 0) {
          taskDiscoveries.push(
            `Task ${task.taskId} drift: planned files not found on disk: ${verification.missingPlanned.join(', ')}`
          )
        }

        // Build descriptive failure reason for UI surfacing
        const verifyFailParts: string[] = []
        if (verification.missingClaimed.length > 0) verifyFailParts.push(`${verification.missingClaimed.length} claimed missing`)
        if (verification.staleClaimed.length > 0) verifyFailParts.push(`${verification.staleClaimed.length} stale`)
        if (verification.missingPlanned.length > 0) verifyFailParts.push(`${verification.missingPlanned.length} planned missing`)
        const verifyFailReason = `verification failed — ${verifyFailParts.join(', ')}`

        taskResult = { success: false, completion, discoveries: taskDiscoveries, failureReason: verifyFailReason }
      } else {
        // FIX-2: No-write-activity hard-fail rule.
        // If the completion claims filesCreated/filesModified BUT the session never
        // invoked a write-capable tool, the files on disk are stale from a prior run.
        // Also fail when no completion + zero write calls + task has planned files.
        const claimedFiles = asStringArray(completion?.filesCreated).length + asStringArray(completion?.filesModified).length
        const hasPlannedFiles = task.filePathsJson?.length > 0
        const noWriteActivity = writeToolCalls === 0 && bashCalls === 0

        if (noWriteActivity && (claimedFiles > 0 || (!completion && hasPlannedFiles))) {
          bpLog.error(
            `[executeTask] Task ${task.taskId} FAILED — no-write-activity: ` +
            `claimed ${claimedFiles} file(s) but session invoked 0 write tools and 0 Bash calls`
          )
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: `⚠ Task ${task.taskId} FAILED — no write-tool activity detected (stale file guard)`,
            kind: 'system'
          })
          taskResult = { success: false, completion, discoveries: taskDiscoveries, failureReason: 'no-write-activity' }
        } else {
          taskResult = { success: true, completion, discoveries: taskDiscoveries }
        }
      }
      } // end of sendOutcome === 'ok' else block
    } catch (err) {
      tComplete = Date.now()
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

      // GAP-3 FIX: Include error message as failureReason for UI surfacing
      taskResult = { success: false, completion: null, discoveries: [], failureReason: err instanceof Error ? err.message : String(err) }
    } finally {
      // Phase 0: Record slot-freed time + build timing object
      const tSlotFreed = Date.now()
      const timing: TaskTiming = {
        taskId: task.taskId,
        wave: waveNum,
        tDispatch,
        tSessionReady,
        tFirstChunk,
        tComplete,
        tSlotFreed,
        durationMs: tSlotFreed - tDispatch
      }
      taskResult.timing = timing

      // Emit timing before cleanup so it's recorded even if stop() hangs
      this.safeEmit('taskTiming', { workspaceId, blueprintId, timing })
      bpLog.info(
        `[executeTask] TIMING task=${task.taskId} ` +
        `spawn=${tSessionReady ? tSessionReady - tDispatch : '?'}ms ` +
        `prefill=${tFirstChunk && tSessionReady ? tFirstChunk - tSessionReady : '?'}ms ` +
        `llm=${tComplete && tFirstChunk ? tComplete - tFirstChunk : '?'}ms ` +
        `teardown=async total=${tSlotFreed - tDispatch}ms`
      )

      cleanupAskUser()
      session.removeListener('chunk', onChunk)
      session.removeListener('statusUpdate', onStatus)
      this.perTaskStatus.delete(statusKey)

      // Phase 1.1: Take teardown OFF the critical path.
      // Resolve the task promise NOW (freeing the dispatch slot), then stop the
      // session fire-and-forget. The session remains in activeSessions until stop
      // settles so cancelBlueprint() can still find and kill it.
      // BP-SESSION-LEAK-01 preserved: stop() failure still triggers cleanup.
      session.stop().catch((stopErr) => {
        bpLog.error(`[executeTask] session.stop() failed for task ${task.taskId}:`, stopErr)
      }).finally(() => {
        const sessions = this.activeSessions.get(workspaceId)
        if (sessions) {
          sessions.delete(session)
          if (sessions.size === 0) this.activeSessions.delete(workspaceId)
        }
      })
    }

    return taskResult
  }

  // ── Task Context Builder ──

  /**
   * Format a BlueprintTask into a context string for the adapter.
   * Includes task ID, description, file paths, user story, and dependencies.
   */
  private buildTaskContext(task: BlueprintTask, priorDiscoveries?: string[], priorAttemptOutput?: string): string {
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

    // BP-RETRY-TASK-CONTEXT: Prior attempt output (on retry)
    if (priorAttemptOutput) {
      lines.push('')
      lines.push('**⚠️ Prior Attempt Output (this task failed previously):**')
      // Cap at 4K to avoid bloating the per-task prompt
      const MAX_PRIOR_CHARS = 4000
      const capped = priorAttemptOutput.length > MAX_PRIOR_CHARS
        ? priorAttemptOutput.slice(0, MAX_PRIOR_CHARS) + '\n…[truncated]'
        : priorAttemptOutput
      lines.push(capped)
      lines.push('')
      lines.push('Build on this work — do NOT restart from scratch. Re-read modified files to verify state.')
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
