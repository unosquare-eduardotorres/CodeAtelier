/**
 * BlueprintBuildService — orchestrates the BUILD phase of the Blueprint pipeline.
 *
 * Unlike previous phases (one-shot), BUILD iterates through tasks grouped by wave.
 * Each task gets its own AgentSessionService with write access (session.start('build')).
 *
 * Scheduling (DAG mode, default): tasks dispatch as soon as their declared
 * `dependsOn` dependencies are settled, regardless of wave grouping — waves
 * remain advisory grouping for the UI. The scheduler is a greedy parallel
 * loop with a file-overlap guard, exclusive-task blocking, graceful drain on
 * failure, and overload backoff (see executeDag / src/shared/task-dag.ts).
 *
 * Degradation: a dependency cycle, or the `dagScheduling` preference off,
 * falls back to the classic wave-barrier scheduler (executeWave).
 *
 * Follows the BlueprintReviewService pattern for event emission + error handling.
 */

import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { basename, normalize } from 'node:path'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
  STALL_TIMEOUT_MS,
  wireAskUserAutoResponder
} from './blueprint-phase-watchdog'
import type {
  BlueprintTask,
  BlueprintTaskOutcomeKind,
  BlueprintPhaseStartPayload,
  BlueprintPhaseCompletePayload,
  BlueprintPhaseArtifactPayload,
  BlueprintWaveStartPayload,
  BlueprintWaveTaskStartPayload,
  BlueprintWaveTaskCompletePayload,
  BlueprintWaveCompletePayload,
  BlueprintTaskGatesPayload
} from '../../shared/blueprint-types'
import { AgentSessionService } from './agent-session.service'
import { BlueprintBuildAdapter } from './role-adapters/blueprint/blueprint-build.adapter'
import { buildBuildGoalCondition } from './blueprint-goal-conditions'
import { blueprintVerifyService } from './blueprint-verify.service'
import { blueprintCodeReviewService } from './blueprint-code-review.service'
import {
  parsePhaseCompletionBlock,
  parseDiscoveriesBlock,
  asStringArray
} from './blueprint-artifact-parsers'
import { verifyBuildTaskFiles } from './blueprint-task-verification'
import { fingerprintGateFailure } from './blueprint-failure-fingerprint'
import {
  buildGateFixInstructions,
  captureGateBaseline,
  runGates,
  runWaveCommandGates,
  type GateBaseline,
  type GateTaskContext
} from './blueprint-gates.service'
import {
  boundEvidence,
  buildGateReport,
  ledgerItemsFrom,
  type GateReport,
  type UnverifiedItem
} from '../../shared/gate-types'
import { normalizePath } from '../../shared/gate-analysis'
import { resolveGateCommands } from '../../shared/gate-command-resolver'
import type { GateCommandSet, ResolvedGateCommands } from '../../shared/gate-command-types'
import type { WorkspaceManifests } from '../../shared/gate-command-detect'
import { readWorkspaceManifests } from './blueprint-preflight.service'
import { parseGateCommands } from '../../shared/blueprint-artifact-parsers'
import { renderWorkPacket } from '../../shared/work-packet-prompt'
import {
  buildTaskDag,
  readyTasks,
  markComplete,
  collectTransitiveDependents,
  isDepSatisfied,
  type TaskDag
} from '../../shared/task-dag'
import { modelConfigService } from './model-config.service'
import { blueprintService, capArtifactForIpc } from './blueprint.service'
import { codeGraphService } from './code-graph.service'
import {
  blueprintRepository,
  blueprintPhaseRepository,
  blueprintTaskRepository
} from '../db/repositories/blueprint.repository'
import { appPreferenceRepository } from '../db/repositories/app-preference.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import {
  runPreflightChecks,
  buildPreflightDiscoveries,
  scanGateCommands
} from './blueprint-preflight.service'
import { primaryTreeLock, primaryTreeBusyError } from './track.service'
import {
  ensureBlueprintTrack,
  blueprintTrackOwner,
  branchHeldElsewhereError
} from './blueprint-track'
import { recordBaselineCommit } from './blueprint-modified-files'

const bpLog = log.scope('blueprint-build')

/** Format peer-review findings as builder fix instructions (M5). Exported for tests. */
export function buildPeerReviewFixInstructions(
  findings: import('../../shared/task-review-types').ReviewFinding[]
): string {
  if (findings.length === 0) return ''
  const sections = findings.map(
    (f) =>
      `### ${f.category}: ${f.file}${f.location ? ` (${f.location})` : ''}\n` +
      `- Issue: ${f.issue}\n` +
      `- Required change: ${f.requiredChange}` +
      (f.howVerified ? `\n- How to verify: ${f.howVerified}` : '')
  )
  return (
    'A peer reviewer examined the previous attempt against the work packet and ' +
    'found the gaps below. They are advisory — fix them in this attempt.\n\n' +
    sections.join('\n\n')
  )
}

const TASK_TIMEOUT_MS = 30 * 60_000 // 30 min per task

/**
 * Builder attempts per task before the escalation ladder hands over to the
 * lead model: the first run plus MAX_BUILDER_ATTEMPTS-1 gate-driven retries.
 * Bounded on purpose — a weak model that cannot satisfy a gate in three tries
 * is not going to on the fourth, and the strong model is cheaper than the loop.
 */
const MAX_BUILDER_ATTEMPTS = 3

// ── Overload retry constants ──
const OVERLOAD_MAX_RETRIES = 2 // 3 total attempts per task
const OVERLOAD_BACKOFF_BASE_MS = 60_000 // 60s, then 120s (exponential)

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
  tDispatch: number // When dispatchTask was called
  tSessionReady: number // session.start() resolved
  tFirstChunk: number // First stream chunk received (prefill latency proxy)
  tComplete: number // session.send() promise settled
  tSlotFreed: number // Task promise resolved (slot available for next dispatch)
  durationMs: number // tSlotFreed - tDispatch (total wall time)
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
  taskFailures: Array<{ taskId: string; reason: string; environmental?: boolean }>
  /**
   * F4 — set when a failing wave-gate report also contains an environmental
   * reason (`command_missing` / `command_error`): the host lacks a tool, so
   * retrying cannot change the outcome. Human-readable; flows into the retry
   * context snapshot so the UI can disable the Retry button after reload.
   */
  environmentalFailure?: string
  /** DAG scheduler observability — quantifies the parallelism win and diagnoses stalls. */
  scheduler?: SchedulerStats
}

/**
 * Scheduler observability (D5 of the DAG plan): per-task ready→dispatch wait,
 * drain count, and a parallelism histogram. `mode` records whether the run
 * used the DAG scheduler or fell back to wave barriers (cycle / pref off).
 */
export interface SchedulerStats {
  mode: 'dag' | 'wave-fallback'
  /** taskId → ms spent ready-but-not-dispatched (dependency wait beyond cap/file guards). */
  perTaskWaitMs: Record<string, number>
  /** Number of times the loop hit a natural frontier stall (drain points). */
  drainCount: number
  /** Peak concurrent in-flight tasks. */
  maxParallelism: number
  /** Histogram: concurrency level → how many loop iterations ran at that level. */
  parallelismHistogram: Record<number, number>
  /** Why wave fallback was used, when it was. */
  fallbackReason?: string
}

/** Return type for executeTask, including timing data. */
interface TaskResult {
  success: boolean
  completion: Record<string, unknown> | null
  discoveries: string[]
  timing?: TaskTiming
  /** When success=false, the reason for failure (session outcome or 'no-write-activity'). */
  failureReason?: string
  /** How the task closed — persisted so a reload still explains the outcome. */
  outcomeKind?: BlueprintTaskOutcomeKind
  /** Verdict of the deterministic gates for the final attempt, when they ran. */
  gateReport?: GateReport
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

/**
 * R2.1 — manifest files whose creation/change can alter detected gate commands.
 * A scaffold task that writes `package.json` brings the whole toolchain online;
 * a cached "no commands" resolution would keep every later task's command
 * gates `unverifiable` for the rest of the phase.
 */
const MANIFEST_FILE_PATTERNS: readonly RegExp[] = [
  /(^|\/)package\.json$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)pyproject\.toml$/,
  /\.csproj$/,
  /(^|\/)go\.mod$/
]

/** Does a repo-relative path name a toolchain manifest? (R2.1) */
export function isManifestFile(path: string): boolean {
  const norm = normalizePath(path)
  return MANIFEST_FILE_PATTERNS.some((p) => p.test(norm))
}

/**
 * BP-WRITE-TOOLS-01: write-capable tool names, lowercased.
 *
 * Covers BOTH naming conventions the executors emit — Claude CLI PascalCase
 * (Write/Edit/MultiEdit/NotebookEdit) and OpenCode lowercase
 * (write/edit/multiedit/applypatch/apply_patch). Matching is case-insensitive
 * at the call site so `Write` and `write` both count. Bash is classified
 * separately (isBashTool) because it is write-capable only sometimes.
 */
const WRITE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'applypatch',
  'apply_patch'
])

/** BP-WRITE-TOOLS-01: is this tool call file-writing? (case-insensitive) */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOL_NAMES.has(name.toLowerCase())
}

/** BP-WRITE-TOOLS-01: is this tool call Bash? (case-insensitive) */
export function isBashTool(name: string): boolean {
  return /^bash$/i.test(name)
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
  /**
   * C3 FIX: blueprints whose current run already emitted its terminal event.
   * Guards finalizeFailed/finalizeSuccess against duplicate terminal emissions
   * when a cancelled pipeline's catch/finally fire late (log-confirmed Aug 28:
   * `cancelled + fail` / `cancelled + phaseComplete` pairs). Cleared when a new
   * run starts (startBuildPhase) so retries work.
   */
  private settledBlueprints = new Set<string>()
  /** G2: Per-task status tracking for derived workspace status. */
  private perTaskStatus = new Map<string, AgentStatus['status']>()
  /** Per-blueprint resolved gate commands — detection walks the disk, so cache it. */
  private gateCommandCache = new Map<string, ResolvedGateCommands>()

  async startBuildPhase(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
  }): Promise<void> {
    const { blueprintId, workspaceId, workspacePath } = params

    bpLog.info(`[startBuildPhase] Blueprint ${blueprintId} — starting BUILD`)

    // C3 FIX: new run — clear any settled flag left by the previous run so
    // finalizeFailed/finalizeSuccess can emit this run's terminal event.
    this.settledBlueprints.delete(blueprintId)

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

    // BUILD gets its own working tree (see blueprint-track.ts). When it does,
    // nothing below touches the user's checkout and no lock is needed — the run
    // is fully parallel with chats and with other blueprints.
    //
    // When it does NOT — the workspace opted out of auto-branching, or the
    // branch is held elsewhere — BUILD falls back to writing in the primary
    // tree, which is where it always used to run. That tree has one HEAD and up
    // to `parallelBuildAgents` agents writing at once, and the wave scheduler
    // has no idea chats or MPA runs exist, so in that case the run claims it.
    //
    // One claim per run, not per task: the tasks ARE the run, and a per-task
    // claim would just serialise the wave scheduler against itself. The id is
    // shared with VERIFY so the BUILD→VERIFY handoff is one continuous claim
    // rather than a gap another writer can slip into.
    const primaryTreeOwnerId = `blueprint:${blueprintId}`
    let holdsPrimaryTree = false
    let executionPath = workspacePath
    // Set when the run is refused for a reason no retry can change, so the
    // catch below can tag the retry context environmental rather than leaving
    // the user a Retry button that is guaranteed to lose.
    let environmentalBlocker: string | undefined

    try {
      // BP-PHASE-TRYCATCH-SCOPE-01: All initialization inside try so
      // finally's markPipelineStopped() is guaranteed to run.

      // 1. Pipeline + DB state
      blueprintService.markPipelineRunning(workspaceId, blueprintId, 'build')
      this.activeBlueprintIds.set(workspaceId, blueprintId)

      const track = await ensureBlueprintTrack({ blueprintId, workspaceId, workspacePath })
      executionPath = track.path

      // R046 — split brain. The branch this run's work lives on is checked out
      // by somebody else, so BUILD fell back to the primary tree: its writes
      // could not reach that branch, and verification would stat a tree the
      // agents never wrote in and report finished work as missing. The app
      // already detected this exact condition and logged it at warn level while
      // running the phase anyway — two attempts, 754s of model time, same
      // deterministic verdict. It is a precondition, not a warning.
      //
      // Only `heldBy` blocks. The other non-isolated cases (auto-branching off,
      // the blueprint set to run in the checkout, no commits yet, the checkout
      // already on the branch) are legitimate and keep running.
      if (!track.isolated && track.heldBy) {
        // Resolve the phase row before throwing: the normal lookup is further
        // down (past the lock), and finalizeFailed needs an id to mark failed —
        // the renderer finds the environmental banner via the failed phase's
        // context snapshot, so without this the refusal would be invisible.
        buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
        const refusal = branchHeldElsewhereError(track.heldBy)
        environmentalBlocker = refusal.message
        throw refusal
      }

      // Baseline for the VERIFY "Modified Files" section — snapshot HEAD of
      // the tree BUILD will run in before any task touches it. Best-effort:
      // non-git workspaces simply get no modified-files list.
      try {
        const existing = blueprintRepository.findById(blueprintId)
        const existingBaseline = (existing?.settingsJson as Record<string, unknown>)?.baselineCommit
        if (!existingBaseline) {
          await recordBaselineCommit(blueprintId, executionPath, (id, key, value) => {
            const current = blueprintRepository.findById(id)
            blueprintRepository.update(id, {
              settingsJson: {
                ...(current?.settingsJson as Record<string, unknown>),
                [key]: value
              }
            })
          })
        }
      } catch (err) {
        bpLog.warn(`[startBuildPhase] baseline commit capture failed (non-fatal):`, err)
      }

      if (!track.isolated) {
        if (
          !primaryTreeLock.acquire(workspaceId, {
            ownerKind: 'blueprint',
            ownerId: primaryTreeOwnerId,
            reason: 'A blueprint BUILD phase'
          })
        ) {
          throw primaryTreeBusyError(primaryTreeLock.holder(workspaceId))
        }
        holdsPrimaryTree = true
      }

      buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
      if (buildPhase) {
        blueprintPhaseRepository.updateStatus(buildPhase.id, 'active')
      }

      blueprintRepository.updateStatus(blueprintId, 'building')
      blueprintRepository.update(blueprintId, { currentPhase: 'build' })

      // M7.1 — capture the run's starting commit ONCE (first build start only).
      // The code-review phase diffs baseline..HEAD to assemble the whole-feature
      // diff; without this it would fall back to a merge-base guess. Stored on
      // settingsJson so it survives retries and app restarts.
      try {
        const bpRec = blueprintRepository.findById(blueprintId)
        const settings = (bpRec?.settingsJson ?? {}) as Record<string, unknown>
        if (!settings.buildBaselineCommit) {
          const head = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: executionPath,
            encoding: 'utf-8',
            maxBuffer: 1024 * 1024
          }).trim()
          if (head) {
            blueprintRepository.update(blueprintId, {
              settingsJson: { ...settings, buildBaselineCommit: head }
            })
            bpLog.info(`[startBuildPhase] Captured build baseline commit ${head.slice(0, 8)}`)
          }
        }
      } catch (baselineErr) {
        // Not a git repo / git missing — code-review degrades to merge-base or
        // records no_git. Never blocks the build.
        bpLog.warn('[startBuildPhase] Build baseline capture failed (non-fatal):', baselineErr)
      }

      // 2. Assemble phase context (includes spec + clarify + plan + tasks + review artifacts + workspace docs)
      const phaseContext = await blueprintService.assemblePhaseContext(
        blueprintId,
        'build',
        workspacePath,
        blueprintService.resolveWorkspaceContextWindow(workspacePath)
      )

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
        // Preflight probes the tree the agents will actually work in — a
        // missing tool or absent .env is only interesting where the build runs.
        const preflightResult = await runPreflightChecks(executionPath, pfTaskDescriptions)

        if (preflightResult.hasBlockers || preflightResult.hasWarnings) {
          const currentBp = blueprintRepository.findById(blueprintId)
          const preflightOverride = (currentBp?.settingsJson as Record<string, unknown>)
            ?.preflightOverride as boolean | undefined
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
      const remediationRound = (currentBlueprint?.settingsJson as Record<string, unknown>)
        ?.remediationRound as number | undefined
      if (remediationRound && remediationRound > 0) {
        const verifyPhaseRecord = blueprintPhaseRepository.findByBlueprintAndPhase(
          blueprintId,
          'verify'
        )
        if (verifyPhaseRecord) {
          const verifyArtifact = verifyPhaseRecord.artifactsJson.findLast(
            (a) => a.type === 'verify'
          )
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
                const files = Array.isArray(f.files)
                  ? ` [${(f.files as string[]).slice(0, 5).join(', ')}]`
                  : ''
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
            gapSummary = md.length > 1500 ? '…' + md.slice(-1500) : md
          }

          if (gapSummary) {
            // Ensure summary fits in a single discovery entry (max 2000 chars)
            if (gapSummary.length > 2000) {
              gapSummary = gapSummary.slice(0, 2000) + '…[truncated]'
            }
            result.discoveries.push(`[VERIFY GAPS - Round ${remediationRound}] ${gapSummary}`)
            bpLog.info(
              `[startBuildPhase] Seeded verify findings (${gapSummary.length} chars) into remediation context`
            )
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

      // 3b. Bootstrap the code-graph index if none exists — ensures Wave 1+ agents
      // get a populated graph for code-graph tool calls.
      //
      // Indexed against the tree BUILD will actually run in, under its own scope
      // when that is a track. The track is on its own branch, so the primary
      // tree's index describes a different set of files entirely — which is how
      // agents ended up grepping by hand for components the graph had never seen.
      const graphScopeId =
        executionPath === workspacePath
          ? workspaceId
          : (() => {
              try {
                return workspaceRepository.ensureShadow(
                  workspaceId,
                  executionPath,
                  basename(executionPath)
                ).id
              } catch (err) {
                bpLog.warn(`[startBuildPhase] Shadow index scope failed (non-fatal):`, err)
                return workspaceId
              }
            })()
      if (!codeGraphService.hasPersistedIndex(graphScopeId)) {
        try {
          bpLog.info(`[startBuildPhase] Bootstrapping code-graph index for ${graphScopeId}`)
          await codeGraphService.indexWorkspace(graphScopeId, executionPath)
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
      // 5. Execute — DAG mode (default) or classic wave barriers
      const dagEnabled = appPreferenceRepository.getAppPreferences().dagScheduling
      const allTasks = [...waveMap.values()].flat()
      const dag = buildTaskDag(allTasks)
      let useDag = dagEnabled
      if (dagEnabled && dag.cycle) {
        useDag = false
        bpLog.warn(
          `[startBuildPhase] Task dependency cycle (${dag.cycle.join(' → ')}) — ` +
            `falling back to wave-barrier scheduling`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text: `⚠ Task dependency cycle (${dag.cycle.join(' → ')}) — using wave scheduling for this build`,
          kind: 'system'
        })
      }
      if (dagEnabled && dag.unknownDeps.length > 0) {
        // Reported at TASKS persist time too — this is the runtime backstop.
        bpLog.warn(
          `[startBuildPhase] Unknown dependsOn ids ignored: ` +
            dag.unknownDeps.map((u) => `${u.taskId}→${u.dep}`).join(', ')
        )
      }
      result.scheduler = {
        mode: useDag ? 'dag' : 'wave-fallback',
        perTaskWaitMs: {},
        drainCount: 0,
        maxParallelism: 0,
        parallelismHistogram: {},
        ...(useDag
          ? {}
          : { fallbackReason: dag.cycle ? 'dependency cycle' : 'dagScheduling preference off' })
      }

      if (useDag) {
        await this.executeDag({
          dag,
          blueprintId,
          workspaceId,
          workspacePath,
          executionPath,
          phaseContext,
          result
        })
      } else {
        for (const waveNum of sortedWaves) {
          const waveTasks = waveMap.get(waveNum) ?? []
          await this.executeWave({
            waveNum,
            waveTasks,
            blueprintId,
            workspaceId,
            workspacePath,
            executionPath,
            phaseContext,
            result
          })
          if (result.failed) break
        }
      }

      // 6. Save build phase artifact (summary)
      // Phase 0: Log aggregate timing per-wave
      if (result.taskTimings.length > 0) {
        const avgDuration =
          result.taskTimings.reduce((s, t) => s + t.durationMs, 0) / result.taskTimings.length
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
            taskTimings: result.taskTimings,
            scheduler: result.scheduler
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
        const failureSummary =
          result.taskFailures.length > 0
            ? result.taskFailures.map((f) => `${f.taskId}: ${f.reason}`).join('; ')
            : 'One or more build tasks failed'
        // BP-RETRY-CONTEXT: Save structured retry context with files/task progress
        try {
          blueprintService.saveRetryContext(blueprintId, 'build', {
            error: failureSummary,
            filesModified: result.filesModified,
            filesCreated: result.filesCreated,
            tasksCompleted: result.tasksCompleted,
            totalTasks,
            environmentalFailure: result.environmentalFailure
          })
        } catch {
          /* best effort */
        }
        this.finalizeFailed(
          blueprintId,
          workspaceId,
          buildPhase?.id ?? null,
          failureSummary,
          workspacePath
        )
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
      // F6/F7 FIX: the run already settled (finalizeSuccess or finalizeFailed
      // emitted this run's terminal phaseComplete — settledBlueprints is
      // cleared at run start). A late throw must not run the failure-path work
      // below: the task-skipping loop would mark completed tasks 'skipped',
      // and the partial-artifact write + saveRetryContext would record a
      // failure that didn't happen. finalizeFailed re-entry is already guarded.
      if (this.settledBlueprints.has(blueprintId)) {
        bpLog.warn(`[startBuildPhase] Post-settlement throw ignored:`, err)
        // F3 FIX: still surface it to the human — a swallowed post-completion
        // failure would otherwise look like a silent stall.
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text: `⚠️ Post-completion error (phase already settled): ${
            err instanceof Error ? err.message : String(err)
          }`
        })
        return
      }
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
            try {
              blueprintTaskRepository.updateStatus(task.id, 'skipped')
            } catch {
              /* best effort — DB may be the cause of the original throw */
            }
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
        } catch {
          /* best effort — DB may be the cause of the original throw */
        }
      }
      // BP-RETRY-CONTEXT: Save structured retry context with files/task progress
      try {
        blueprintService.saveRetryContext(blueprintId, 'build', {
          error: err instanceof Error ? err.message : String(err),
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          tasksCompleted: result.tasksCompleted,
          totalTasks,
          environmentalFailure: environmentalBlocker
        })
      } catch {
        /* best effort */
      }
      this.finalizeFailed(
        blueprintId,
        workspaceId,
        buildPhase?.id ?? null,
        err instanceof Error ? err.message : String(err),
        workspacePath
      )
    } finally {
      this.activeSessions.delete(workspaceId)
      this.activeBlueprintIds.delete(workspaceId)
      // Only mark pipeline stopped if verify was NOT auto-triggered.
      // When verify is triggered, its own finally block owns markPipelineStopped()
      // to avoid destroying the AbortController that the verify phase needs.
      //
      // The primary-tree claim is handed over on exactly the same condition:
      // finalizeSuccess() starts VERIFY synchronously (it re-acquires under the
      // same owner id), so releasing here would free the tree out from under a
      // phase that is already running in it. VERIFY's own finally releases.
      if (!verifyTriggered) {
        blueprintService.markPipelineStopped(workspaceId)
        if (holdsPrimaryTree) primaryTreeLock.release(workspaceId, primaryTreeOwnerId)
      }
    }
  }

  // ── DAG Execution (Graph-wide Parallel Scheduler) ──

  /**
   * Execute the whole task graph with readiness-based dispatch.
   *
   * Same scheduling model as executeWave (greedy scan, file-overlap guard,
   * exclusive-task blocking, graceful drain, overload backoff) lifted
   * graph-wide: a task dispatches as soon as its `dependsOn` deps are
   * settled, regardless of wave grouping. Waves remain advisory grouping.
   *
   * Differences from the wave loop, all deliberate:
   * - Ready set is rank-ordered by critical-path depth (upwardRank) — the
   *   longest chain to the sink dispatches first when a slot frees.
   * - Overload cap-halving is build-scoped, not per-wave.
   * - Wave gates run at DRAIN POINTS: inFlight = ∅ ∧ readySet = ∅ ∧ ≥1 task
   *   completed since the last gate run — the natural frontier stall, the
   *   same settled-tree invariant the end-of-wave point provided.
   * - Failure cascade is reachability-based: only transitive dependents of
   *   failed tasks (plus undispatched tasks at drain) are skipped; healthy
   *   peers keep running.
   */
  private async executeDag(params: {
    dag: TaskDag
    blueprintId: string
    workspaceId: string
    /** Workspace identity — the primary tree. Never a cwd. */
    workspacePath: string
    /** Where the agents write (run worktree or primary tree). */
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
  }): Promise<void> {
    const { dag, blueprintId, workspaceId, workspacePath, executionPath, phaseContext, result } =
      params
    const stats = result.scheduler!

    // Build-scoped cap (clamped 1–6, default 3). Mutable — halved on overload.
    let cap = appPreferenceRepository.getAppPreferences().parallelBuildAgents

    const inFlight = new Map<string, InFlightEntry>()
    const dispatched = new Set<string>()
    const terminal = new Set<string>() // settled this run: complete/failed/user-skipped
    let exclusiveInFlight = false
    let draining = false
    const overloadRetries = new Map<string, number>()
    const reportedFiles = new Map<string, Set<string>>()
    const failedTaskIds = new Set<string>()
    // Per-task ready timestamp: when the task first entered the ready set.
    const readySince = new Map<string, number>()
    // Drain-point gate bookkeeping.
    let completionsSinceGate = 0
    let gatesRun = 0

    /** Live task record by taskId (DB row, refreshed on demand). */
    const taskById = new Map<string, BlueprintTask>()
    for (const rec of blueprintTaskRepository.findByBlueprint(blueprintId)) {
      taskById.set(rec.taskId, rec)
    }

    // ── Resume pre-pass: settle already-settled tasks (mirrors executeWave) ──
    // A task that is 'complete' or user-skipped in the DB never dispatches;
    // it counts toward completion the way a completed task does. Without this
    // pre-pass the ready-set scan would re-dispatch them.
    let resumedCount = 0
    let userSkippedCount = 0
    for (const node of dag.nodes.values()) {
      const rec = taskById.get(node.taskId)
      if (!rec) continue
      if (rec.skippedByUserAt) {
        terminal.add(node.taskId)
        result.tasksCompleted++
        userSkippedCount++
        markComplete(dag, node.taskId)
        this.safeEmit('waveTaskComplete', {
          blueprintId,
          workspaceId,
          wave: node.wave,
          taskId: node.taskId,
          status: 'skipped'
        } satisfies BlueprintWaveTaskCompletePayload)
      } else if (rec.status === 'complete') {
        terminal.add(node.taskId)
        result.tasksCompleted++
        result.tasksResumed++
        resumedCount++
        markComplete(dag, node.taskId)
        this.safeEmit('waveTaskComplete', {
          blueprintId,
          workspaceId,
          wave: node.wave,
          taskId: node.taskId,
          status: 'complete'
        } satisfies BlueprintWaveTaskCompletePayload)
      }
    }
    if (resumedCount > 0 || userSkippedCount > 0) {
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text: `Skipping ${resumedCount} already-completed and ${userSkippedCount} user-skipped task${resumedCount + userSkippedCount > 1 ? 's' : ''} (resume)`,
        kind: 'system'
      })
    }

    /** Waves whose waveStart has been emitted (lazy — first dispatch in the wave). */
    const wavesStarted = new Set<number>()

    /** Readiness predicate: dep settled ⇔ complete ∨ user-skipped. */
    const isSatisfied = (taskId: string): boolean => {
      if (terminal.has(taskId)) return true
      const rec = taskById.get(taskId)
      const status = rec?.status ?? 'pending'
      return isDepSatisfied(status, rec?.skippedByUserAt ?? null)
    }

    /**
     * A task whose status is a stale cascade-skip (skipped, no user timestamp)
     * is NOT settled — and must not be dispatched either. It stays blocked,
     * surfaces as blocked, and its dependents stay blocked with it (the
     * retry path resets cascade-skips before rebuild; a non-reset one must
     * never silently unblock downstream work).
     */
    const isCascadeSkipped = (taskId: string): boolean => {
      const rec = taskById.get(taskId)
      return rec?.status === 'skipped' && !rec.skippedByUserAt && !terminal.has(taskId)
    }

    /**
     * Rank-ordered actionable ready set: deps satisfied, not dispatched, not
     * terminal. (readyTasks also returns terminal tasks with satisfied deps —
     * the caller filters; here that filter is `dispatched`/`terminal`.)
     */
    const actionableReady = (): string[] =>
      readyTasks(dag, isSatisfied).filter(
        (id) => !dispatched.has(id) && !terminal.has(id) && !isCascadeSkipped(id)
      )

    const allInFlightFiles = (): Set<string> => {
      const merged = new Set<string>()
      for (const entry of inFlight.values()) {
        for (const f of entry.files) merged.add(f)
      }
      return merged
    }

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

    const recordParallelism = (): void => {
      const n = inFlight.size
      stats.maxParallelism = Math.max(stats.maxParallelism, n)
      stats.parallelismHistogram[n] = (stats.parallelismHistogram[n] ?? 0) + 1
    }

    /** Dispatch one task (mirrors executeWave's dispatchTask call sites). */
    const dispatch = (taskId: string): boolean => {
      const task = taskById.get(taskId)
      if (!task) return false
      const waveNum = task.wave
      const taskFiles = normalizePaths(task.filePathsJson)
      const waited = readySince.has(taskId) ? Date.now() - readySince.get(taskId)! : 0
      if (waited > 0) stats.perTaskWaitMs[taskId] = waited
      if (!wavesStarted.has(waveNum)) {
        wavesStarted.add(waveNum)
        const waveSize = [...dag.nodes.values()].filter((n) => n.wave === waveNum).length
        this.safeEmit('waveStart', {
          blueprintId,
          workspaceId,
          wave: waveNum,
          taskCount: waveSize
        } satisfies BlueprintWaveStartPayload)
      }
      this.dispatchTask({
        task,
        blueprintId,
        workspaceId,
        workspacePath,
        executionPath,
        phaseContext,
        result,
        waveNum,
        inFlight,
        taskFiles
      })
      dispatched.add(taskId)
      if (taskFiles.size === 0) exclusiveInFlight = true
      syncRunningTasks()
      return true
    }

    /**
     * Drain-point gates: the natural frontier stall. Same settled-tree
     * invariant as the old end-of-wave point — nothing in flight, nothing
     * ready, and real work happened since the last gate run. Diamond graphs
     * produce one stall at the join; no gate inflation.
     */
    const runDrainPointGates = async (): Promise<void> => {
      if (inFlight.size > 0 || actionableReady().length > 0 || completionsSinceGate === 0) return
      const cohort = [...dispatched].filter((id) => !gatedCohorts.has(id))
      if (cohort.length === 0) {
        completionsSinceGate = 0
        return
      }
      const maxWave = cohort.reduce((m, id) => Math.max(m, taskById.get(id)?.wave ?? 0), 0)
      gatesRun++
      stats.drainCount = gatesRun
      bpLog.info(
        `[executeDag] Drain point ${gatesRun}: gates on settled cohort of ${cohort.length} task(s) (max wave ${maxWave})`
      )
      const report = await this.runWaveGates({
        blueprintId,
        workspaceId,
        workspacePath,
        executionPath,
        waveNum: maxWave
      })
      for (const id of cohort) gatedCohorts.add(id)
      completionsSinceGate = 0
      if (report.overall === 'fail') {
        result.failed = true
        draining = true
        this.pushWaveGateFailure(result, `W${maxWave}`, report)
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text: `⚠ Drain-point lint/build failed (${report.gates
            .filter((g) => g.verdict === 'fail')
            .map((g) => g.name)
            .join(', ')}) — stopping build`,
          kind: 'system'
        })
      }
    }
    const gatedCohorts = new Set<string>()

    // ── Main loop ──
    while (true) {
      const abortSignal = blueprintService.getAbortSignal(workspaceId)
      if (abortSignal?.aborted && !draining) {
        bpLog.info(`[executeDag] Aborted — draining ${inFlight.size} in-flight tasks`)
        draining = true
      }

      // Fill slots from the rank-ordered ready set.
      if (!draining && !exclusiveInFlight) {
        for (const taskId of actionableReady()) {
          if (inFlight.size >= cap) break
          if (exclusiveInFlight) break
          const task = taskById.get(taskId)
          if (!task) continue
          const taskFiles = normalizePaths(task.filePathsJson)
          if (taskFiles.size === 0) {
            // Exclusive task: only when nothing else is in flight.
            if (inFlight.size > 0) continue
            dispatch(taskId)
            break
          }
          if (filesOverlap(taskFiles, allInFlightFiles())) continue
          dispatch(taskId)
        }
      }

      recordParallelism()

      // Nothing in flight and nothing dispatchable → drain point or done.
      if (inFlight.size === 0) {
        const ready = actionableReady()
        if (ready.length === 0) {
          if (completionsSinceGate > 0) {
            await runDrainPointGates()
            if (result.failed) break
            continue
          }
          break // settled and gated — done (or stalled: see post-loop check)
        }
        if (!draining) {
          // Ready but blocked by cap/file/exclusive guards with nothing in
          // flight cannot happen for cap; for file/exclusive it also cannot
          // (empty in-flight set never overlaps). Defensive: dispatch head —
          // and bail out if the record is missing so the loop cannot spin.
          if (!dispatch(ready[0])) break
        } else {
          break
        }
      }

      // Wait for ANY in-flight task to settle.
      const settled = await Promise.race(
        [...inFlight.entries()].map(async ([taskId, entry]) => {
          const taskResult = await entry.promise
          return { taskId, entry, taskResult }
        })
      )

      inFlight.delete(settled.taskId)
      if (settled.entry.files.size === 0) exclusiveInFlight = false

      // OVERLOAD-RETRY — same semantics as executeWave, build-scoped cap.
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

          if (priorRetries === 0 && cap > 1) {
            const newCap = Math.max(1, Math.floor(cap / 2))
            bpLog.warn(
              `[executeDag] Task ${settled.taskId} hit API overload — ` +
                `reducing build parallel cap from ${cap} to ${newCap}`
            )
            cap = newCap
          }

          const totalAttempts = OVERLOAD_MAX_RETRIES + 1
          bpLog.info(
            `[executeDag] Task ${settled.taskId} overload retry ${attempt + 1}/${totalAttempts} — backing off ${delay / 1000}s`
          )
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text:
              `⚠ Task ${settled.entry.task.taskId} hit API overload — ` +
              `retrying in ${delay / 1000}s (attempt ${attempt + 1}/${totalAttempts})`,
            kind: 'system'
          })

          const retryTask = settled.entry.task
          const retryFiles = settled.entry.files
          const discoverySnapshot = [...result.discoveries]
          const retryPromise = abortAwareSleep(delay, abortSignal ?? undefined)
            .then(async () => {
              const retryResult = await this.executeTask({
                task: retryTask,
                blueprintId,
                workspaceId,
                workspacePath,
                executionPath,
                phaseContext,
                priorDiscoveries: discoverySnapshot,
                tDispatch: Date.now(),
                waveNum: retryTask.wave
              })
              // An overload re-dispatch is a distinct execution and must count as
              // one, exactly like the three ladder rungs. Without this the retry
              // and the attempt it replaced share an attempt number, on precisely
              // the failure path `turn_usage.attempt` exists to study. Recorded
              // AFTER the call for the same reason as the ladder sites: executeTask
              // reads `attempts` to derive its own attempt number.
              blueprintTaskRepository.recordAttempt(retryTask.id)
              return retryResult
            })
            .catch((_err): TaskResult => ({
              success: false,
              completion: null,
              discoveries: [],
              failureReason: 'aborted'
            }))

          if (settled.taskResult.timing) {
            result.taskTimings.push(settled.taskResult.timing)
          }
          blueprintTaskRepository.updateStatus(retryTask.id, 'running')
          inFlight.set(settled.taskId, {
            promise: retryPromise,
            files: retryFiles,
            task: retryTask
          })
          if (retryFiles.size === 0) exclusiveInFlight = true
          syncRunningTasks()
          continue
        }
      }

      this.handleTaskCompletion({
        task: settled.entry.task,
        taskResult: settled.taskResult,
        blueprintId,
        workspaceId,
        waveNum: settled.entry.task.wave,
        result
      })
      terminal.add(settled.taskId)
      completionsSinceGate++
      markComplete(dag, settled.taskId)

      if (settled.taskResult.success) {
        const modified = asStringArray(settled.taskResult.completion?.filesModified)
        if (modified.length > 0) {
          reportedFiles.set(settled.taskId, normalizePaths(modified))
        }
      } else {
        failedTaskIds.add(settled.taskId)
        if (!draining) {
          bpLog.warn(`[executeDag] Task ${settled.taskId} failed — draining`)
          draining = true
          result.failed = true
        }
      }
      syncRunningTasks()

      // Newly-ready tasks get a ready timestamp for wait-time stats.
      for (const id of actionableReady()) {
        if (!readySince.has(id) && !dispatched.has(id)) readySince.set(id, Date.now())
      }
    }

    blueprintService.setRunningTasks(workspaceId, null)

    // ── Residual-risk hedge: warn on undeclared reported-file overlaps ──
    const taskIdsForOverlap = [...reportedFiles.keys()]
    for (let i = 0; i < taskIdsForOverlap.length; i++) {
      for (let j = i + 1; j < taskIdsForOverlap.length; j++) {
        const a = reportedFiles.get(taskIdsForOverlap[i])!
        const b = reportedFiles.get(taskIdsForOverlap[j])!
        if (filesOverlap(a, b)) {
          const overlap = [...a].filter((f) => b.has(f))
          bpLog.warn(
            `[executeDag] REPORTED FILE OVERLAP: Tasks ${taskIdsForOverlap[i]} and ${taskIdsForOverlap[j]} both modified: ${overlap.join(', ')}`
          )
        }
      }
    }

    // ── Reachability-based skip cascade ──
    // Only transitive dependents of failed tasks, plus anything still
    // undispatched at drain, are skipped. Healthy peers keep their state.
    const doomed =
      draining || result.failed
        ? collectTransitiveDependents(dag, [...failedTaskIds])
        : new Set<string>()
    for (const node of dag.nodes.values()) {
      const rec = taskById.get(node.taskId)
      if (!rec) continue
      const currentStatus = blueprintTaskRepository.findById(rec.id)?.status
      if (currentStatus !== 'pending' && currentStatus !== 'running') continue
      if (!draining && !result.failed) continue
      if (doomed.has(node.taskId) || !dispatched.has(node.taskId)) {
        blueprintTaskRepository.updateStatus(rec.id, 'skipped')
        this.safeEmit('waveTaskComplete', {
          blueprintId,
          workspaceId,
          wave: node.wave,
          taskId: node.taskId,
          status: 'skipped'
        } satisfies BlueprintWaveTaskCompletePayload)
      } else if (currentStatus === 'running') {
        // In-flight at loop exit (abort path): leave it — the session's own
        // abort handling settles it.
        bpLog.info(`[executeDag] Task ${node.taskId} still running at exit — leaving to settle`)
      }
    }

    // ── Stall detection: undischarged tasks that are neither ready nor failed ──
    // A non-reset cascade-skip (or any unsatisfiable dep) leaves dependents
    // blocked forever; surface it instead of hanging or silently skipping.
    if (!draining && !result.failed) {
      const stuck = [...dag.nodes.values()]
        .map((n) => n.taskId)
        .filter(
          (id) =>
            !terminal.has(id) &&
            !dispatched.has(id) &&
            (taskById.get(id)?.status ?? 'pending') === 'pending'
        )
      if (stuck.length > 0) {
        bpLog.warn(
          `[executeDag] ${stuck.length} task(s) blocked on unsatisfied dependencies: ${stuck.join(', ')} — marking skipped`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text: `⚠ ${stuck.length} task(s) blocked on unsatisfiable dependencies (${stuck.join(', ')}) — marked skipped`,
          kind: 'system'
        })
        for (const id of stuck) {
          const rec = taskById.get(id)
          if (!rec) continue
          blueprintTaskRepository.updateStatus(rec.id, 'skipped')
          this.safeEmit('waveTaskComplete', {
            blueprintId,
            workspaceId,
            wave: rec.wave,
            taskId: id,
            status: 'skipped'
          } satisfies BlueprintWaveTaskCompletePayload)
        }
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
    /** Workspace identity — the primary tree. Never a cwd. */
    workspacePath: string
    /**
     * Where the agents write. The run's own worktree, or the primary tree when
     * isolation was unavailable.
     *
     * All tasks in a wave share it, and that is correct: they are one feature
     * on one branch, and `filesOverlap()` already serialises the risky pairs
     * within the wave.
     */
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
  }): Promise<void> {
    const {
      waveNum,
      waveTasks,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath,
      phaseContext,
      result
    } = params

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
    let userSkippedCount = 0
    for (const task of waveTasks) {
      const dbTask = blueprintTaskRepository.findById(task.id)
      const effectiveStatus = dbTask?.status ?? task.status
      // BP-TASK-USER-SKIP-01: a user-skipped task is settled. It is never
      // dispatched and never enters `pending`, so it cannot fail the wave and
      // cannot trigger the downstream skip cascade. It counts toward completion
      // the way a complete task does — the wave is done with it either way.
      if (dbTask?.skippedByUserAt) {
        result.tasksCompleted++
        userSkippedCount++
        bpLog.info(
          `[executeWave] Task ${task.taskId} skipped by user at ${dbTask.skippedByUserAt} — not dispatched`
        )
        this.safeEmit('waveTaskComplete', {
          blueprintId,
          workspaceId,
          wave: waveNum,
          taskId: task.taskId,
          status: 'skipped'
        } satisfies BlueprintWaveTaskCompletePayload)
        continue
      }
      if (effectiveStatus === 'complete') {
        result.tasksCompleted++
        result.tasksResumed++
        skippedCount++
        bpLog.info(`[executeWave] Skipping complete task ${task.taskId} (resume)`)
        this.safeEmit('waveTaskComplete', {
          blueprintId,
          workspaceId,
          wave: waveNum,
          taskId: task.taskId,
          status: 'complete'
        } satisfies BlueprintWaveTaskCompletePayload)
      } else {
        pending.push(task)
      }
    }
    if (skippedCount > 0) {
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text: `Skipping ${skippedCount} already-completed task${skippedCount > 1 ? 's' : ''} in Wave ${waveNum}`,
        kind: 'system'
      })
    }
    if (userSkippedCount > 0) {
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text: `Skipping ${userSkippedCount} user-skipped task${userSkippedCount > 1 ? 's' : ''} in Wave ${waveNum}`,
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

    /**
     * BP-DEPENDSON-DISPATCH-01: a task that declares dependencies must not start
     * while any of them is unfinished *in this wave*.
     *
     * The tasks phase has always emitted `dependsOn` and the repository has
     * always persisted it, but the scheduler only ever guarded on file *writes*.
     * A gate task — one that reads and validates what its wave-mates produce —
     * declares no overlapping files, so it dispatched alongside them and tested
     * against half-applied edits.
     *
     * Only declared dependencies serialize; `[P]` and the file-overlap guard are
     * untouched.
     */
    const blockedByDep = (task: BlueprintTask): boolean => {
      const deps = task.dependsOnJson
      if (!deps?.length) return false
      return deps.some(
        (id) =>
          id !== task.taskId &&
          (inFlight.has(id) || pending.some((p) => p.taskId === id && !dispatched.has(p.taskId)))
      )
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

          // Declared-dependency guard — checked before the file guards so a gate
          // task waits for what it validates even when it declares no files.
          if (blockedByDep(task)) {
            scanStart++
            continue
          }

          const taskFiles = normalizePaths(task.filePathsJson)

          // Exclusive task (no declared files): dispatch only when inFlight is empty
          if (taskFiles.size === 0) {
            if (inFlight.size === 0) {
              // Dispatch exclusive task
              this.dispatchTask({
                task,
                blueprintId,
                workspaceId,
                workspacePath,
                executionPath,
                phaseContext,
                result,
                waveNum,
                inFlight,
                taskFiles
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
            task,
            blueprintId,
            workspaceId,
            workspacePath,
            executionPath,
            phaseContext,
            result,
            waveNum,
            inFlight,
            taskFiles
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
          // Advance past any skipped tasks by dispatching next one exclusively.
          // Prefer the first task whose declared dependencies are all settled —
          // otherwise this fallback would undo the dependsOn guard. If every
          // remaining task is blocked (a dependency cycle the validator missed),
          // take the head anyway: a wrong order beats a hung wave.
          const nextTask =
            pending.slice(pendingIdx).find((t) => !dispatched.has(t.taskId) && !blockedByDep(t)) ??
            pending[pendingIdx]
          const taskFiles = normalizePaths(nextTask.filePathsJson)
          this.dispatchTask({
            task: nextTask,
            blueprintId,
            workspaceId,
            workspacePath,
            executionPath,
            phaseContext,
            result,
            waveNum,
            inFlight,
            taskFiles
          })
          dispatched.add(nextTask.taskId)
          if (taskFiles.size === 0) exclusiveInFlight = true
          syncRunningTasks()
          if (nextTask.taskId === pending[pendingIdx].taskId) pendingIdx++
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
            text:
              `⚠ Task ${settled.entry.task.taskId} hit API overload — ` +
              `retrying in ${delay / 1000}s (attempt ${attempt + 1}/${totalAttempts})`,
            kind: 'system'
          })

          // Build a delayed re-dispatch promise. The sleeping task occupies a slot
          // during backoff (deliberate — reduces API pressure).
          const retryTask = settled.entry.task
          const retryFiles = settled.entry.files
          const discoverySnapshot = [...result.discoveries]
          const retryPromise = abortAwareSleep(delay, abortSignal ?? undefined)
            .then(async () => {
              const retryResult = await this.executeTask({
                task: retryTask,
                blueprintId,
                workspaceId,
                workspacePath,
                executionPath,
                phaseContext,
                priorDiscoveries: discoverySnapshot,
                tDispatch: Date.now(), // Fresh tDispatch for mtime-freshness check
                waveNum
              })
              // Same fix as executeDag: the re-dispatch is its own attempt.
              // §1.2's standing warning — both schedulers or neither.
              blueprintTaskRepository.recordAttempt(retryTask.id)
              return retryResult
            })
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
        blueprintId,
        workspaceId,
        waveNum,
        result
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
            text:
              `⚠ Task ${settled.entry.task.taskId} failed after ${totalAttempts} attempts ` +
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
            blueprintId,
            workspaceId,
            wave: waveNum,
            taskId: task.taskId,
            status: 'skipped'
          } satisfies BlueprintWaveTaskCompletePayload)
        }
      }
    }

    const waveFailedPre = draining || result.failed

    // ── R3.3: wave-level G1/G2 — lint/build once per wave, attributed to the wave ──
    // Per-task command gates were skipped (skipCommandGates) for every dispatched
    // task; this is where they actually run, on a settled tree. A `fail` fails the
    // wave; `unverifiable` lands in the ledger under the wave pseudo-id `W<n>`.
    if (!waveFailedPre && dispatched.size > 0) {
      const waveReport = await this.runWaveGates({
        blueprintId,
        workspaceId,
        workspacePath,
        executionPath,
        waveNum
      })
      if (waveReport.overall === 'fail') {
        result.failed = true
        this.pushWaveGateFailure(result, `W${waveNum}`, waveReport)
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text:
            `⚠ Wave ${waveNum} failed wave-level lint/build: ` +
            waveReport.gates
              .filter((g) => g.verdict === 'fail')
              .map((g) => g.name)
              .join(', ') +
            ' — stopping build',
          kind: 'system'
        })
      }
    }

    const waveFailed = draining || result.failed
    const waveStatus = waveFailed ? 'failed' : 'complete'
    this.safeEmit('waveComplete', {
      blueprintId,
      workspaceId,
      wave: waveNum,
      status: waveStatus
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
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
    waveNum: number
    inFlight: Map<string, InFlightEntry>
    taskFiles: Set<string>
  }): void {
    const {
      task,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath,
      phaseContext,
      result,
      waveNum,
      inFlight,
      taskFiles
    } = params

    // Phase 0: Record dispatch timestamp
    const tDispatch = Date.now()

    this.safeEmit('waveTaskStart', {
      blueprintId,
      workspaceId,
      wave: waveNum,
      taskId: task.taskId,
      description: task.description,
      goal: buildBuildGoalCondition(task.taskId, task.description)
    } satisfies BlueprintWaveTaskStartPayload)

    blueprintTaskRepository.updateStatus(task.id, 'running')

    // Start-time snapshot of discoveries for this task
    const discoverySnapshot = [...result.discoveries]

    const promise = this.executeTaskWithGates({
      task,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath,
      phaseContext,
      priorDiscoveries: discoverySnapshot,
      tDispatch,
      waveNum,
      // R1.2: the wave's in-flight map, so gate-time attribution can exempt
      // peer tasks' declared files from this task's diff.
      inFlight
    })

    inFlight.set(task.taskId, { promise, files: taskFiles, task })
  }

  // ── Gate loop & escalation ladder (M2.8 / M4) ──

  /**
   * Run a task, then grade it with the deterministic gates, retrying on `fail`.
   *
   * The ladder is bounded by construction — worst case per task is
   * MAX_BUILDER_ATTEMPTS builder runs plus one lead-model fix:
   *
   *   attempt 1 → gates fail → attempt 2 (with evidence) → gates fail
   *     → attempt 3 (with evidence) → gates fail → lead model fixes → gates fail
   *     → task failed, phase hard-holds on the existing failure machinery.
   *
   * `unverifiable` never enters the ladder: it is recorded in the ledger, warned
   * about, and the task advances. That is the invariant the whole stack rests on.
   */
  private async executeTaskWithGates(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    priorDiscoveries: string[]
    tDispatch: number
    waveNum: number
    /** R1.2: the wave scheduler's in-flight map, for peer-file exemption. */
    inFlight?: Map<string, InFlightEntry>
  }): Promise<TaskResult> {
    const { task, blueprintId, workspaceId, workspacePath, executionPath } = params

    const gateCtx: GateTaskContext = {
      blueprintId,
      taskId: task.taskId,
      workspacePath,
      executionPath,
      plannedFiles: task.filePathsJson ?? [],
      packet: task.packetJson,
      commands: this.resolveGateCommandsFor(blueprintId, workspacePath),
      // R3.1: manifest snapshot for per-task test targeting (M2.6 Option 2).
      manifests: this.readManifestsCached(blueprintId, workspacePath),
      // R3.3: lint/build run once per WAVE on the settled tree, not per task
      // against peers' mid-flight edits.
      skipCommandGates: true
    }
    this.refreshExemptFiles(gateCtx, params.inFlight)

    // Captured ONCE, before the first attempt: the diff base and the red proof
    // must describe the state the task started from, not the state a failed
    // retry left behind (which would make attempt 2's own edits invisible).
    let baseline: GateBaseline | null = null
    try {
      baseline = await captureGateBaseline(gateCtx)
    } catch (err) {
      // R2.3 — silent degradation fix: a thrown baseline capture used to only
      // log, so every diff-derived gate silently went unverifiable with no
      // ledger entry and no user-visible signal. Record it like any other
      // unverifiable outcome: ledger entry + phaseProgress warning.
      const detail = err instanceof Error ? err.message : String(err)
      bpLog.warn(`[gates] Baseline capture failed for ${task.taskId} — gates degrade:`, detail)
      const ledgerItem: UnverifiedItem = {
        taskId: task.taskId,
        gate: 'write-set',
        reason: 'analysis_unavailable',
        detail: `baseline capture failed: ${detail}`,
        at: new Date().toISOString()
      }
      blueprintRepository.appendUnverified(blueprintId, [ledgerItem])
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Task ${task.taskId}: gate baseline could not be captured ` +
          `(${detail}) — diff-based gates will report unproven`,
        kind: 'system'
      })
    }

    let gateFixInstructions: string | undefined
    let lastResult: TaskResult | null = null
    /** B3 — fingerprint of the previous attempt's gate failure, for the stop-loss. */
    let lastFingerprint = ''

    for (let attempt = 1; attempt <= MAX_BUILDER_ATTEMPTS; attempt++) {
      // P1.2 — refresh gate context per retry iteration. R2.1 invalidates the
      // command/manifest caches when a gate reports `no_command` or a task's
      // write-set touches a toolchain manifest; without this re-read, attempt 2
      // would grade against the same stale resolution attempt 1 saw — a
      // scaffolded toolchain from attempt 1's session would stay invisible.
      if (attempt > 1) {
        gateCtx.manifests = this.readManifestsCached(blueprintId, workspacePath)
        gateCtx.commands = this.resolveGateCommandsFor(blueprintId, workspacePath)
      }

      const result = await this.executeTask({ ...params, gateFixInstructions })
      blueprintTaskRepository.recordAttempt(task.id)
      lastResult = result

      // A task that failed its Layer-1 file verification never reaches the gates:
      // there is nothing to grade, and the existing failure path already explains why.
      if (!result.success || !baseline) return result

      // R1.2: peers may have dispatched/finished since the last gate run — the
      // exemption set is refreshed at gate time, not captured at dispatch time.
      this.refreshExemptFiles(gateCtx, params.inFlight)
      const report = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)
      if (report.overall !== 'fail') {
        // M5 — advisory peer-review pass over the just-passed task. Findings
        // become ONE fix attempt appended to this ladder (never a new wave,
        // never a loop); survivors go to the unverified ledger. A pass failure
        // is ledgered inside the service and never blocks the task.
        const peerReviewed = await this.runPeerReviewIfEnabled({
          ...params,
          baselineCommit: baseline.baselineCommit,
          exemptFiles: gateCtx.exemptFiles
        })
        return { ...result, gateReport: report, ...(peerReviewed ? { peerReviewed } : {}) }
      }

      gateFixInstructions = buildGateFixInstructions(report)
      const failedNames = report.gates
        .filter((g) => g.verdict === 'fail')
        .map((g) => g.name)
        .join(', ')

      // B3 — task-level stop-loss. The phase ladder has carried a recurrence
      // fingerprint since F4; the task ladder had none, so a deterministic gate
      // failure bought MAX_BUILDER_ATTEMPTS full cold sessions — each paying the
      // whole prefix — to produce the same bytes. Two identical fingerprints is
      // the evidence that the builder is not converging; the only rung left that
      // can change the outcome is a DIFFERENT model on a different prompt, so go
      // there now instead of after the third identical failure. A fingerprint
      // that VARIES keeps today's behaviour exactly — the builder is still moving.
      const fingerprint = fingerprintGateFailure(report)
      const stalled = fingerprint !== '' && fingerprint === lastFingerprint
      lastFingerprint = fingerprint

      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Task ${task.taskId} failed quality gate(s): ${failedNames} — ` +
          (stalled
            ? `identical failure ${attempt}× in a row, skipping the remaining builder ` +
              `attempt(s) — escalating to the lead-review model`
            : attempt < MAX_BUILDER_ATTEMPTS
              ? `retrying (attempt ${attempt + 1}/${MAX_BUILDER_ATTEMPTS})`
              : 'escalating to the lead-review model'),
        kind: 'system'
      })

      lastResult = {
        ...result,
        success: false,
        failureReason: `quality gate failed: ${failedNames}`,
        gateReport: report
      }

      if (stalled) {
        // Persist the reason the ladder was cut short. handleTaskCompletion only
        // records an outcome for the FINAL verdict, and escalation may still
        // pass — without this the skipped rungs leave no trace at all.
        blueprintTaskRepository.setOutcome(task.id, {
          failureReason:
            `stop-loss after ${attempt} identical gate failure(s) ` +
            `(${failedNames}) — skipped ${MAX_BUILDER_ATTEMPTS - attempt} builder ` +
            `attempt(s), escalated to blueprint:lead-review`
        })
        bpLog.warn(
          `[gates] Task ${task.taskId} stop-loss: gate failure fingerprint unchanged ` +
            `across ${attempt} attempts — skipping ${MAX_BUILDER_ATTEMPTS - attempt} ` +
            `builder attempt(s) and escalating`
        )
        break
      }
    }

    // Builder retries exhausted — one attempt by the strong model, then hard hold.
    return this.escalateToLead({ ...params, gateCtx, baseline, gateFixInstructions, lastResult })
  }

  /**
   * M5 — advisory per-task peer review, dispatched after the gates pass.
   *
   * Off unless the `blueprint:peer-review` role is bound (an optional role —
   * `isRoleEnabled` returns false for unbound workspaces, so the common path
   * pays nothing). Exactly one round (PEER_REVIEW_MAX_ROUNDS = 1):
   *   findings → ONE fix attempt with the findings as instructions → gates
   *   re-run → survivors → unverified ledger (gate `peer-review`, reason
   *   `finding_unresolved`). Never blocks: a fix attempt that fails its gates
   *   keeps the task's passing state from the original attempt.
   */
  private async runPeerReviewIfEnabled(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    priorDiscoveries: string[]
    tDispatch: number
    waveNum: number
    baselineCommit: string | null
    exemptFiles?: readonly string[]
    inFlight?: Map<string, InFlightEntry>
  }): Promise<boolean> {
    const { task, blueprintId, workspaceId, workspacePath } = params

    if (!modelConfigService.isRoleEnabled(workspacePath, 'blueprint:peer-review')) return false

    const { blueprintPeerReviewService } = await import('./blueprint-peer-review.service')
    const outcome = await blueprintPeerReviewService.reviewTask({
      task,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath: params.executionPath,
      baselineCommit: params.baselineCommit,
      exemptFiles: params.exemptFiles
    })

    if (!outcome.fixDispatched) return false

    // ONE advisory fix attempt: the findings become the fix instructions.
    // This is appended to the task's existing retry ladder — not a new wave.
    const fixInstructions = buildPeerReviewFixInstructions(outcome.review.findings)
    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'build',
      text: `Peer review: task ${task.taskId} — one advisory fix attempt for ${outcome.review.findings.length} finding(s)`,
      kind: 'system'
    })

    const fixResult = await this.executeTask({ ...params, gateFixInstructions: fixInstructions })
    blueprintTaskRepository.recordAttempt(task.id)

    if (!fixResult.success) {
      // The fix attempt failed to produce a session result — the original
      // passing attempt stands; the findings are unresolved, so ledger them.
      blueprintPeerReviewService.recordSurvivingFindings(
        blueprintId,
        task.taskId,
        outcome.review.findings
      )
      return true
    }

    // Re-grade the fixed tree. A pass supersedes the findings; a fail or
    // unverifiable means the findings survived — ledger them, never block.
    const gateCtx: GateTaskContext = {
      blueprintId,
      taskId: task.taskId,
      workspacePath,
      executionPath: params.executionPath,
      plannedFiles: task.filePathsJson ?? [],
      packet: task.packetJson,
      commands: this.resolveGateCommandsFor(blueprintId, workspacePath),
      manifests: this.readManifestsCached(blueprintId, workspacePath),
      skipCommandGates: true
    }
    this.refreshExemptFiles(gateCtx, params.inFlight)
    const baseline: GateBaseline = {
      baselineCommit: params.baselineCommit,
      preexistingDirty: [],
      testsBefore: {},
      redProof: 'unavailable',
      redEvidence: []
    }
    const fixReport = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)
    if (fixReport.overall === 'fail') {
      blueprintPeerReviewService.recordSurvivingFindings(
        blueprintId,
        task.taskId,
        outcome.review.findings
      )
    }
    return true
  }

  /**
   * Run the gates for one attempt and persist the verdict.
   *
   * Persisting here rather than at the end of the ladder is deliberate: a crash
   * mid-retry must still leave the evidence that explains what the run was doing.
   */
  private async gradeTask(
    gateCtx: GateTaskContext,
    baseline: GateBaseline,
    task: BlueprintTask,
    blueprintId: string,
    workspaceId: string
  ): Promise<GateReport> {
    let report: GateReport
    try {
      report = await runGates(gateCtx, baseline)
    } catch (err) {
      // A crash in the gate engine must not fail the user's task. Unverifiable
      // is the honest verdict: we do not know whether the work was good.
      bpLog.error(`[gates] Gate run threw for ${task.taskId} — recording unverifiable:`, err)
      report = buildGateReport([
        {
          name: 'build',
          verdict: 'unverifiable',
          reason: 'analysis_unavailable',
          evidence: boundEvidence([err instanceof Error ? err.message : String(err)]),
          durationMs: 0
        }
      ])
    }

    const ledgerItems = ledgerItemsFrom(report, task.taskId)
    blueprintTaskRepository.setGateReport(task.id, report, ledgerItems)

    // R2.1 — gate-command cache invalidation. Two triggers:
    //   (a) a command gate could not resolve a command: the toolchain may have
    //       appeared since the cache was built (scaffold task wrote package.json);
    //   (b) this task's declared write-set intersects a toolchain manifest: the
    //       toolchain may have just been created or rewritten.
    // Invalidation is cheap (one disk scan) and self-correcting: the next task
    // re-resolves, and if nothing changed the answer is identical.
    const noCommand = report.gates.some(
      (g) => g.verdict === 'unverifiable' && g.reason === 'no_command'
    )
    const touchedManifest = [
      ...(task.packetJson?.allowedFiles ?? []),
      ...(task.filePathsJson ?? [])
    ].some((f) => typeof f === 'string' && isManifestFile(f))
    if (noCommand || touchedManifest) {
      this.gateCommandCache.delete(gateCtx.blueprintId)
      this.manifestCache.delete(gateCtx.blueprintId)
      bpLog.info(
        `[gates] R2.1 cache invalidation for ${gateCtx.blueprintId} ` +
          `(${noCommand ? 'no_command' : ''}${noCommand && touchedManifest ? ' + ' : ''}${touchedManifest ? 'manifest write-set' : ''})`
      )
    }

    if (ledgerItems.length > 0) {
      // M4.3: unverifiable warns and continues. It taints the terminal status
      // through the ledger; it never blocks a task or a phase.
      blueprintRepository.appendUnverified(blueprintId, ledgerItems)
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Task ${task.taskId}: ${ledgerItems.length} check(s) could not be verified ` +
          `(${ledgerItems.map((i) => `${i.gate}/${i.reason}`).join(', ')}) — continuing, recorded as unproven`,
        kind: 'system'
      })
    }

    this.safeEmit('taskGates', {
      blueprintId,
      workspaceId,
      taskId: task.taskId,
      report
    } satisfies BlueprintTaskGatesPayload)

    return report
  }

  /**
   * M4.2 — fixer of last resort. One attempt by the `blueprint:lead-review`
   * model, which is a mandatory role precisely so this rung always exists.
   */
  private async escalateToLead(params: {
    task: BlueprintTask
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    priorDiscoveries: string[]
    tDispatch: number
    waveNum: number
    gateCtx: GateTaskContext
    baseline: GateBaseline | null
    gateFixInstructions?: string
    lastResult: TaskResult | null
    /** R1.2: the wave scheduler's in-flight map, for peer-file exemption. */
    inFlight?: Map<string, InFlightEntry>
  }): Promise<TaskResult> {
    const { task, blueprintId, workspaceId, gateCtx, baseline, lastResult } = params

    blueprintTaskRepository.setEscalatedTo(task.id, 'blueprint:lead-review')
    bpLog.warn(
      `[gates] Task ${task.taskId} exhausted ${MAX_BUILDER_ATTEMPTS} builder attempt(s) — escalating`
    )

    const result = await this.executeTask({
      ...params,
      gateFixInstructions: params.gateFixInstructions,
      modelAction: 'blueprint:lead-review'
    })
    blueprintTaskRepository.recordAttempt(task.id)

    if (!result.success || !baseline) {
      return result.success ? result : (result ?? lastResult ?? result)
    }

    this.refreshExemptFiles(gateCtx, params.inFlight)
    const report = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)
    if (report.overall !== 'fail') return { ...result, gateReport: report }

    const failedNames = report.gates
      .filter((g) => g.verdict === 'fail')
      .map((g) => g.name)
      .join(', ')
    return {
      ...result,
      success: false,
      failureReason: `quality gate failed after escalation: ${failedNames}`,
      gateReport: report
    }
  }

  /**
   * R1.2 — recompute `gateCtx.exemptFiles` from the wave's current in-flight
   * set: every OTHER task's declared files (scheduler write-set ∪ packet
   * allowedFiles). Called at gate time because the in-flight set changes as
   * peers dispatch and settle; a dispatch-time snapshot would go stale.
   */
  private refreshExemptFiles(
    gateCtx: GateTaskContext,
    inFlight: Map<string, InFlightEntry> | undefined
  ): void {
    if (!inFlight) return
    const exempt = new Set<string>()
    for (const [taskId, entry] of inFlight) {
      if (taskId === gateCtx.taskId) continue
      for (const f of entry.files) exempt.add(f)
      for (const f of entry.task.packetJson?.allowedFiles ?? []) exempt.add(f)
    }
    gateCtx.exemptFiles = [...exempt]
  }

  /**
   * F1d — turn a failing wave-gate report into a `taskFailures` entry so the
   * phase-failure summary (and the retry context / UI) says WHY, not just
   * "One or more build tasks failed". Gate name + verdict + the first few
   * evidence lines — the shell's "'pytest' is not recognized" line used to be
   * captured and never shown (incident 2026-08, ~20 blind retries).
   */
  private pushWaveGateFailure(
    result: BuildResult,
    waveLabel: string,
    report: GateReport
  ): void {
    const failed = report.gates.filter((g) => g.verdict === 'fail')
    for (const gate of failed) {
      const evidence = gate.evidence.slice(0, 3).join(' | ')
      result.taskFailures.push({
        taskId: waveLabel,
        reason: `gate ${gate.name} failed${evidence ? ` — ${evidence}` : ''}`,
        // F4 — a FAILED gate whose reason says the runner was absent is
        // environmental. Post-F1c these are normally `unverifiable`, but the
        // flag keeps the entry self-describing if a future path grades them.
        ...(gate.reason === 'command_missing' || gate.reason === 'command_error'
          ? { environmental: true }
          : {})
      })
    }

    // F4 — environmental classification: scan the WHOLE report, not just the
    // failed set. Post-F1c a missing runner is `unverifiable(command_missing)`
    // — it sits beside the genuinely-red gates that failed the wave. Its
    // presence means part of this failure is deterministic on this machine:
    // no retry can make the missing tool appear (incident 2026-08, ~20 blind
    // retries). Tag the result so the retry context — and the UI's Retry
    // button — can say so specifically.
    const environmental = report.gates.find(
      (g) => g.reason === 'command_missing' || g.reason === 'command_error'
    )
    if (environmental && !result.environmentalFailure) {
      const firstEvidence = (environmental.evidence[0] ?? '').trim().slice(0, 200)
      result.environmentalFailure =
        `${environmental.name} gate could not run` +
        (firstEvidence
          ? ` — ${firstEvidence}`
          : ' — the command runner is not available on this machine')
    }
  }

  /**
   * R3.3 — run the wave-level command gates (lint/build/full-suite) and
   * persist the verdict: `fail` → ledger-free hard wave failure;
   * `unverifiable` → ledger entries under the wave pseudo-task id `W<n>` so
   * the terminal status is tainted without blocking anything.
   *
   * P1.1 — the report is also appended to the build phase as a `wave-gates`
   * artifact, so the evidence survives app reload (the in-memory `taskGates`
   * event is transient) and the UI can render it in the build deliverable.
   */
  private async runWaveGates(params: {
    blueprintId: string
    workspaceId: string
    workspacePath: string
    executionPath: string
    waveNum: number
  }): Promise<GateReport> {
    const { blueprintId, workspaceId, workspacePath, executionPath, waveNum } = params
    const waveTaskId = `W${waveNum}`

    const ctx: GateTaskContext = {
      blueprintId,
      taskId: waveTaskId,
      workspacePath,
      executionPath,
      plannedFiles: [],
      packet: null,
      commands: this.resolveGateCommandsFor(blueprintId, workspacePath)
    }

    // P1.3 — progress pings: a full lint+build+test pass on a real repo can run
    // for many minutes with zero output. Tell the user what is happening so the
    // phase doesn't look hung.
    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'build',
      text: `Wave ${waveNum}: running lint/build/test gates — this can take a while`,
      kind: 'system'
    })

    let report: GateReport
    try {
      report = await runWaveCommandGates(ctx)
    } catch (err) {
      bpLog.error(`[gates] Wave gate run threw for ${waveTaskId}:`, err)
      report = buildGateReport([
        {
          name: 'build',
          verdict: 'unverifiable',
          reason: 'analysis_unavailable',
          evidence: boundEvidence([err instanceof Error ? err.message : String(err)]),
          durationMs: 0
        }
      ])
    }

    // P1.1 — persist the wave report as a build-phase artifact (mirrors the
    // discoveries pattern). Best-effort: a DB failure here must not turn a
    // passing wave into a failed one.
    try {
      const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
      if (buildPhase) {
        blueprintPhaseRepository.appendArtifact(buildPhase.id, {
          type: 'wave-gates',
          contentJson: { wave: waveNum, report }
        })
      }
    } catch (err) {
      bpLog.warn(`[gates] Could not persist wave-gates artifact for ${waveTaskId}:`, err)
    }

    const ledgerItems = ledgerItemsFrom(report, waveTaskId)
    if (ledgerItems.length > 0) {
      blueprintRepository.appendUnverified(blueprintId, ledgerItems)
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Wave ${waveNum}: ${ledgerItems.length} check(s) could not be verified ` +
          `(${ledgerItems.map((i) => `${i.gate}/${i.reason}`).join(', ')}) — continuing, recorded as unproven`,
        kind: 'system'
      })
    }

    // P1.3 — completion line: name the verdict so the log reads as a story.
    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'build',
      text:
        `Wave ${waveNum} gates: ${report.overall}` +
        ` (${report.gates.map((g) => `${g.name}:${g.verdict}`).join(' ')})`,
      kind: 'system'
    })

    this.safeEmit('taskGates', {
      blueprintId,
      workspaceId,
      taskId: waveTaskId,
      report
    } satisfies BlueprintTaskGatesPayload)

    return report
  }

  /**
   * R3.1 — manifest snapshot cache, invalidated together with the gate-command
   * cache (same triggers, same lifetime): the toolchain that decides test
   * targeting is the toolchain that decides gate commands.
   */
  private manifestCache = new Map<string, WorkspaceManifests>()

  private readManifestsCached(blueprintId: string, workspacePath: string): WorkspaceManifests {
    const cached = this.manifestCache.get(blueprintId)
    if (cached) return cached
    let manifests: WorkspaceManifests = {}
    try {
      manifests = readWorkspaceManifests(workspacePath)
    } catch (err) {
      bpLog.warn('[gates] Manifest read failed — test targeting degrades:', err)
    }
    this.manifestCache.set(blueprintId, manifests)
    return manifests
  }

  /**
   * Resolve this blueprint's gate commands once and cache them for the phase.
   *
   * Cached because detection walks the disk and the declaration is parsed out of
   * the PLAN artifact — doing that per task, per retry, for every wave is pure
   * overhead for an answer that cannot change mid-phase.
   *
   * R2.1 — the cache is invalidated (see `invalidateGateCommandCache`) when a
   * command gate reports `no_command` (the toolchain may have appeared since)
   * or when a task's write-set intersects a toolchain manifest (the toolchain
   * may have just been created or rewritten).
   */
  private resolveGateCommandsFor(blueprintId: string, workspacePath: string): ResolvedGateCommands {
    const cached = this.gateCommandCache.get(blueprintId)
    if (cached) return cached
    return this.rebuildGateCommandCache(blueprintId, workspacePath)
  }

  /** Re-run detection and replace the cached resolution. R2.1. */
  private rebuildGateCommandCache(
    blueprintId: string,
    workspacePath: string
  ): ResolvedGateCommands {
    let declared: GateCommandSet = {}
    try {
      const planPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'plan')
      for (const artifact of planPhase?.artifactsJson ?? []) {
        if (!artifact.contentMd) continue
        const parsed = parseGateCommands(artifact.contentMd)
        if (Object.keys(parsed).length > 0) declared = { ...declared, ...parsed }
      }
    } catch (err) {
      bpLog.warn('[gates] Could not read declared gate commands from the PLAN artifact:', err)
    }

    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const resolved = resolveGateCommands({
      override: settings?.gateCommands as GateCommandSet | undefined,
      declared,
      detected: scanGateCommands(workspacePath)
    })

    this.gateCommandCache.set(blueprintId, resolved)
    bpLog.info(
      `[gates] Commands for ${blueprintId}: ` +
        (Object.entries(resolved)
          .map(([kind, cmd]) => `${kind}=${cmd.command} (${cmd.provenance})`)
          .join(', ') || 'none resolved — command gates will report unverifiable')
    )
    return resolved
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
      const verifiedUnchanged = asStringArray(taskResult.completion?.filesVerifiedUnchanged)
      blueprintTaskRepository.setCompletion(task.id, {
        filesCreated: created,
        filesModified: modified,
        ...(verifiedUnchanged.length > 0 ? { filesVerifiedUnchanged: verifiedUnchanged } : {})
      })

      // Record how it closed and clear any reason left over from a prior attempt.
      blueprintTaskRepository.setOutcome(task.id, {
        outcomeKind: taskResult.outcomeKind ?? 'verified',
        failureReason: null
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
      const reason = taskResult.failureReason ?? 'unknown'
      result.taskFailures.push({ taskId: task.taskId, reason })
      // Persist it too — the event is transient, so without this a reload leaves
      // nothing on disk explaining why the task is red, and the retry that
      // follows has no idea what it is walking back into.
      blueprintTaskRepository.setOutcome(task.id, { failureReason: reason, outcomeKind: null })
    }

    this.safeEmit('waveTaskComplete', {
      blueprintId,
      workspaceId,
      wave: waveNum,
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
    // C3 FIX: one terminal event per run — a late catch/finally must not
    // re-fail an already-settled (or cancelled) pipeline.
    if (this.settledBlueprints.has(blueprintId)) {
      bpLog.info(
        `[finalizeFailed] Blueprint ${blueprintId} already settled — ignoring late failure`
      )
      return
    }
    this.settledBlueprints.add(blueprintId)
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
          blueprintId,
          workspaceId,
          workspacePath,
          phase: 'build',
          error: errorMsg
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
    // C3 FIX: one terminal event per run (see settledBlueprints).
    if (this.settledBlueprints.has(blueprintId)) {
      bpLog.info(
        `[finalizeSuccess] Blueprint ${blueprintId} already settled — ignoring late success`
      )
      return
    }
    this.settledBlueprints.add(blueprintId)
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
      artifact: capArtifactForIpc({
        type: 'build',
        contentMd: this.buildArtifactSummary(
          result.tasksCompleted,
          totalTasks,
          result.filesCreated,
          result.filesModified,
          result.tasksResumed
        )
      })
    } satisfies BlueprintPhaseArtifactPayload)

    // Auto-trigger the next phase (non-blocking).
    // BP-VERIFY-AUTOFIRE-01: M6 wire-once pattern means listeners are always active.
    // No per-workspace wiring needed.
    //
    // M7.4 — when the code-review role is enabled, build advances to
    // CODE-REVIEW (the adversarial whole-diff layer) instead of jumping to
    // VERIFY; the code-review service advances to verify on completion.
    // When the role is disabled, settleOptionalPhases marks the phase record
    // `skipped` (R1.3 re-wire) and the pipeline goes build → verify directly.
    const codeReviewEnabled = modelConfigService.isRoleEnabled(
      workspacePath,
      'blueprint:code-review'
    )
    if (codeReviewEnabled) {
      try {
        blueprintCodeReviewService
          .startCodeReviewPhase({ blueprintId, workspaceId, workspacePath })
          .catch((err) => {
            bpLog.error('[build→code-review] Code-review phase failed:', err)
            const errorMsg = err instanceof Error ? err.message : String(err)
            blueprintService.failPipeline(workspaceId, errorMsg)
            blueprintRepository.updateStatus(blueprintId, 'failed')
          })
      } catch (syncErr) {
        bpLog.error('[build→code-review] Code-review startup failed (sync):', syncErr)
        const errorMsg = syncErr instanceof Error ? syncErr.message : String(syncErr)
        blueprintService.failPipeline(workspaceId, errorMsg)
        blueprintRepository.updateStatus(blueprintId, 'failed')
      }
      return
    }

    // Role disabled — settle the optional phase record, then VERIFY.
    blueprintService.settleOptionalPhases(blueprintId)
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
    /** The run's worktree — where this task's files land and are verified. */
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    priorDiscoveries: string[]
    tDispatch: number
    waveNum: number
    /** Set on a gate-driven retry — mechanical evidence from the failed attempt. */
    gateFixInstructions?: string
    /** Routes this session to a different role model (escalation). */
    modelAction?: import('../../shared/types').ModelAction
  }): Promise<TaskResult> {
    const {
      task,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath,
      phaseContext,
      tDispatch,
      waveNum
    } = params

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
    const taskContext = this.buildTaskContext(
      task,
      params.priorDiscoveries,
      priorPartial?.contentMd,
      task.failureReason,
      params.gateFixInstructions,
      modelConfigService.isLocalProvider(workspacePath)
    )

    // Attribution for this session's usage rows. `recordAttempt` bumps the
    // counter AFTER executeTask returns, so the stored value is the number of
    // prior attempts and this run is the next one.
    const attempt = (blueprintTaskRepository.findById(task.id)?.attempts ?? 0) + 1

    // Create adapter + session
    const adapter = new BlueprintBuildAdapter({
      workspaceId,
      blueprintId,
      phaseContext,
      taskContext,
      taskId: task.taskId,
      attempt,
      ...(params.modelAction ? { modelAction: params.modelAction } : {})
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
    // BP-WRITE-TOOLS-01: matching is case-insensitive and covers BOTH naming
    // conventions — Claude CLI emits PascalCase (Write/Edit/MultiEdit), OpenCode
    // emits lowercase (write/edit/multiedit/applypatch/apply_patch). See the
    // module-level isWriteTool/isBashTool helpers.
    let writeToolCalls = 0
    let bashCalls = 0
    // BP-WRITE-TOOLS-01: one debug line per task so future tool-name drift is
    // visible without re-reading the normalizer.
    const observedToolNames = new Set<string>()
    // WAVE-RACE FIX: first executor-level error chunk wins. When the OpenCode
    // server fails to start (ServeError / port conflict), the turn ends with
    // `session=none chunks=1` — a single error chunk, no completion block. The
    // downstream disk verification then reports "N planned missing", which is
    // only the symptom. This captures the actionable cause.
    // Boxed in an object so closure assignments keep the `string | null` type
    // (a bare `let` narrows to `never` at the read sites after CFA).
    const executorErrorBox: { value: string | null } = { value: null }

    const onChunk = (chunk: StreamChunk): void => {
      // Phase 0: Record first chunk time (prefill latency proxy)
      if (tFirstChunk === 0) tFirstChunk = Date.now()
      stallWatchdog.touch()

      // WAVE-RACE FIX: capture the first error chunk (see executorErrorBox above)
      if (chunk.type === 'error' && executorErrorBox.value === null) {
        executorErrorBox.value = typeof chunk.error === 'string' ? chunk.error : String(chunk.error)
      }
      // FIX-2: Count write-capable tool invocations
      if (chunk.type === 'tool_use' && chunk.toolName) {
        observedToolNames.add(chunk.toolName)
        if (isWriteTool(chunk.toolName)) writeToolCalls++
        if (isBashTool(chunk.toolName)) bashCalls++
      }

      forwardBlueprintChunk((event, payload) => this.safeEmit(event, payload), chunk, {
        blueprintId,
        workspaceId,
        phase: 'build',
        workspacePath: executionPath,
        mode: 'build',
        taskId: task.taskId
      })
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
      const derivedStatus = wsStatuses.some(
        (s) => s !== 'idle' && s !== 'completed' && s !== 'failed'
      )
        ? 'busy'
        : 'idle'
      this.safeEmit('status', { workspaceId, status: { ...status, status: derivedStatus } })
    }
    session.on('chunk', onChunk)
    session.on('statusUpdate', onStatus)

    // B4-FIX: Auto-respond to ask_user calls — build is non-interactive
    const cleanupAskUser = wireAskUserAutoResponder(session, 'BUILD')

    let taskResult: TaskResult = { success: false, completion: null, discoveries: [] }
    // BP-CATCH-SCOPE-01: Declared outside try/catch so the catch block (which saves
    // partial output on failure) can read the same conversation id the try block used.
    const syntheticConvId = `blueprint-build-${blueprintId}-${task.taskId}-${Date.now()}`

    try {
      // Start session in BUILD mode (write access).
      // When blueprintAutoMode is enabled, use 'danger' to bypass permission prompts —
      // the user already approved execution when starting the blueprint.
      const autoMode = appPreferenceRepository.getAppPreferences().blueprintAutoMode
      // `workspacePath` stays the repo root so the session still resolves its
      // workspace id — and with it the cost preference, provider, compaction
      // thresholds and the four workspace-scoped MCP servers. The cwd comes
      // from the track owner instead. Passing the worktree here would move the
      // cwd and silently drop all of that.
      await session.start(workspacePath, autoMode ? 'danger' : 'build', {
        trackOwner: blueprintTrackOwner(blueprintId)
      })
      tSessionReady = Date.now()

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
        taskResult = {
          success: false,
          completion: null,
          discoveries: [],
          failureReason: sendOutcome
        }
      } else {
        // Parse output
        const text = session.getStreamedContent(syntheticConvId)
        const completion = parsePhaseCompletionBlock(text, 'build') ?? null

        if (!completion && text.length > 200) {
          bpLog.warn(
            `[executeTask] Task ${task.taskId}: no completion block in ${text.length}-char output`
          )
        }
        bpLog.info(
          `[executeTask] Task ${task.taskId} complete — status: ${completion?.status ?? 'unknown'}`
        )

        // Parse discoveries block from task output
        const taskDiscoveries = parseDiscoveriesBlock(text) ?? []

        // BP-VERIFY-TASK-FILES-01: Deterministic disk verification — never trust unverified claims.
        // Check that files the LLM claimed to create/modify actually exist on disk.
        // FIX-3: Pass tDispatch as taskStartedAt for mtime freshness checking.
        // Claimed paths are resolved against this root and anything escaping it
        // is rejected, so the wrong root fails every claim in the task.
        // The primary checkout is passed as the secondary root: planned paths are
        // recorded as absolute paths in it, so claims naming them must be re-rooted
        // onto the worktree rather than reported missing (R007).
        const verification = verifyBuildTaskFiles({
          executionPath,
          workspacePath,
          completion,
          plannedFiles: task.filePathsJson,
          taskStartedAt: tDispatch
        })

        // BP-ACCEPTANCE-DEVIATION-01: an acceptance criterion that baked in a
        // count discovered while planning ("all 78 commands") fails correct work
        // when the source has since drifted. The agent reports the mismatch
        // instead of failing on it — it surfaces as a warning for VERIFY and the
        // human, not as a red task.
        const acceptanceDeviation =
          typeof completion?.acceptanceDeviation === 'string'
            ? completion.acceptanceDeviation.trim()
            : ''
        if (acceptanceDeviation) {
          const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
          if (buildPhase) {
            blueprintPhaseRepository.appendArtifact(buildPhase.id, {
              type: 'verification-warning',
              contentMd:
                `## Task ${task.taskId} — acceptance criterion deviates from the source\n\n` +
                `${acceptanceDeviation}\n`
            })
          }
          taskDiscoveries.push(`Task ${task.taskId} acceptance deviation: ${acceptanceDeviation}`)
        }

        // FIX-2: No-write-activity hard-fail rule (hoisted — the unproven branch
        // below needs it too). A completion that claims files while the session
        // invoked no write-capable tool and no Bash is describing a prior run's
        // output, not this one. This is the *direct* measurement of "did the agent
        // work"; mtime freshness is only a proxy for it.
        const claimedFiles =
          asStringArray(completion?.filesCreated).length +
          asStringArray(completion?.filesModified).length
        const hasPlannedFiles = task.filePathsJson?.length > 0
        const noWriteActivity = writeToolCalls === 0 && bashCalls === 0

        // BP-VERIFY-UNPROVEN-01: "exists but not provably fresh" is not "missing".
        // An agent that inspects code, finds it already correct and declines to
        // rewrite it produces stale-only claims — identical on disk to an agent
        // that did nothing. The two are separated by write activity, not by mtime,
        // and not (as before) by pattern-matching the task description.
        if (verification.verdict === 'unproven' && !noWriteActivity) {
          bpLog.warn(
            `[executeTask] Task ${task.taskId} verification UNPROVEN — ` +
              `${verification.staleClaimed.length} claimed file(s) exist but are not fresh; ` +
              `session made ${writeToolCalls} write call(s) and ${bashCalls} Bash call(s) — passing with warning`
          )
          // Append a warning artifact (not failure) so it's visible in Deliverables
          const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
          if (buildPhase) {
            blueprintPhaseRepository.appendArtifact(buildPhase.id, {
              type: 'verification-warning',
              contentMd:
                `## Task ${task.taskId} — completed, freshness unproven\n\n` +
                `Every file this task claimed is present on disk, but ` +
                `${verification.staleClaimed.length} of them were not modified during this run. ` +
                `The session did perform write activity, so the task is treated as complete ` +
                `— VERIFY still checks the same files.\n\n` +
                `**Unproven files (${verification.staleClaimed.length}):**\n` +
                verification.staleClaimed.map((f) => `- \`${f}\``).join('\n') +
                '\n'
            })
          }
          taskDiscoveries.push(
            `Task ${task.taskId}: ${verification.staleClaimed.length} claimed file(s) exist but were unmodified this run — verify their content.`
          )
          taskResult = {
            success: true,
            completion,
            discoveries: taskDiscoveries,
            outcomeKind: 'unproven'
          }
        } else if (!verification.ok) {
          // F5 — all-zero discrepancy: `!ok` with zero missing/stale/planned means
          // there was no completion block to verify against (the turn likely
          // died in an API/transport error before emitting one). The generic
          // counts message would render "0 claimed missing, 0 stale, 0 planned
          // missing" — three empty sections that explain nothing.
          const allZero =
            verification.missingClaimed.length === 0 &&
            verification.staleClaimed.length === 0 &&
            verification.missingPlanned.length === 0
          const missingList =
            verification.missingClaimed.length > 0
              ? verification.missingClaimed
              : verification.missingPlanned
          if (allZero) {
            bpLog.error(
              `[executeTask] Task ${task.taskId} FAILED verification — no completion block ` +
                `in CLI output (the turn likely ended in an API/transport error); ` +
                `no file discrepancies found`
            )
          } else {
            bpLog.error(
              `[executeTask] Task ${task.taskId} FAILED verification — ` +
                `${verification.missingClaimed.length} claimed missing, ` +
                `${verification.staleClaimed.length} stale, ` +
                `${verification.missingPlanned.length} planned missing: ` +
                `${missingList.slice(0, 10).join(', ')}${missingList.length > 10 ? ` (+${missingList.length - 10} more)` : ''}`
            )
          }

          // Append artifact so the discrepancy is visible in Deliverables
          const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
          if (buildPhase) {
            blueprintPhaseRepository.appendArtifact(buildPhase.id, {
              type: 'verification-failure',
              contentMd: allZero
                ? `## Task ${task.taskId} — status could not be determined\n\n` +
                  `The CLI output contained no completion block, so there were no claims ` +
                  `to verify. This usually means the turn ended in an API or transport ` +
                  `error before the agent could report. No file discrepancies were found.\n`
                : `## Task ${task.taskId} — claimed files missing on disk\n\n` +
                  (verification.missingClaimed.length > 0
                    ? `**Claimed but absent (${verification.missingClaimed.length}):**\n` +
                      verification.missingClaimed.map((f) => `- \`${f}\``).join('\n') +
                      '\n\n'
                    : '') +
                  (verification.staleClaimed.length > 0
                    ? `**Claimed but stale (${verification.staleClaimed.length}):**\n` +
                      verification.staleClaimed.map((f) => `- \`${f}\``).join('\n') +
                      '\n\n'
                    : '') +
                  (verification.missingPlanned.length > 0
                    ? `**Planned but absent (${verification.missingPlanned.length}):**\n` +
                      verification.missingPlanned.map((f) => `- \`${f}\``).join('\n') +
                      '\n'
                    : '')
            })
          }

          // Surface to UI via existing phaseProgress channel (system message)
          // GAP-2 FIX: Include stale-aware branch so the message reflects the real reason
          this.safeEmit('phaseProgress', {
            blueprintId,
            workspaceId,
            phase: 'build',
            text: allZero
              ? `⚠ Task ${task.taskId} marked FAILED — no completion block in CLI output ` +
                `(the turn likely ended in an API/transport error); no file discrepancies found`
              : `⚠ Task ${task.taskId} marked FAILED — ` +
                (verification.missingClaimed.length > 0
                  ? `claimed ${claimedFiles} file(s), ${verification.missingClaimed.length} missing on disk`
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
          if (verification.missingClaimed.length > 0)
            verifyFailParts.push(`${verification.missingClaimed.length} claimed missing`)
          if (verification.staleClaimed.length > 0)
            verifyFailParts.push(`${verification.staleClaimed.length} stale`)
          if (verification.missingPlanned.length > 0)
            verifyFailParts.push(`${verification.missingPlanned.length} planned missing`)
          const verifyFailReason = allZero
            ? 'verification failed — no completion block in CLI output (turn likely ended in an API/transport error)'
            : `verification failed — ${verifyFailParts.join(', ')}`

          // WAVE-RACE FIX: when the session never produced a completion block
          // AND the executor emitted an error, the error is the actionable
          // cause — the missing files are only the symptom of a session that
          // died before writing anything.
          const failureReason =
            !completion && executorErrorBox.value
              ? `executor error: ${executorErrorBox.value.slice(0, 200)}`
              : verifyFailReason

          taskResult = {
            success: false,
            completion,
            discoveries: taskDiscoveries,
            failureReason
          }
        } else {
          // If the completion claims files BUT the session never invoked a
          // write-capable tool, the files on disk are stale from a prior run.
          // Also fail when no completion + zero write calls + task has planned files.
          // This is the guard that keeps the R029 hole shut now that stale-only
          // claims no longer hard-fail on their own.
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
            taskResult = {
              success: false,
              completion,
              discoveries: taskDiscoveries,
              // WAVE-RACE FIX: executor error (server failed to start / died)
              // is the actionable cause when present — see executorErrorBox above.
              failureReason:
                !completion && executorErrorBox.value
                  ? `executor error: ${executorErrorBox.value.slice(0, 200)}`
                  : 'no-write-activity'
            }
          } else {
            taskResult = {
              success: true,
              completion,
              discoveries: taskDiscoveries,
              outcomeKind:
                verification.preexistingClaimed.length > 0 && claimedFiles === 0
                  ? 'preexisting'
                  : 'verified'
            }
          }
        }
      } // end of sendOutcome === 'ok' else block
    } catch (err) {
      tComplete = Date.now()
      bpLog.error(`[executeTask] Task ${task.taskId} failed:`, err)

      // Save partial output if available
      const partialText = session.getStreamedContent(syntheticConvId)
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
      taskResult = {
        success: false,
        completion: null,
        discoveries: [],
        failureReason: err instanceof Error ? err.message : String(err)
      }
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
      // BP-WRITE-TOOLS-01: observed tool names, once per task (debug) — makes
      // future name drift visible without re-reading the normalizer.
      bpLog.debug(
        `[executeTask] Task ${task.taskId} tool usage — writes=${writeToolCalls} ` +
          `bash=${bashCalls} observed=[${[...observedToolNames].sort().join(', ')}]`
      )
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
      session
        .stop()
        .catch((stopErr) => {
          bpLog.error(`[executeTask] session.stop() failed for task ${task.taskId}:`, stopErr)
        })
        .finally(() => {
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
  private buildTaskContext(
    task: BlueprintTask,
    priorDiscoveries?: string[],
    priorAttemptOutput?: string,
    priorFailureReason?: string | null,
    /** Mechanical gate-failure instructions for a retry (M4.1). */
    gateFixInstructions?: string,
    /** Strictest packet wording for small-context local models. */
    strictPacket?: boolean
  ): string {
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
      const capped =
        priorAttemptOutput.length > MAX_PRIOR_CHARS
          ? priorAttemptOutput.slice(0, MAX_PRIOR_CHARS) + '\n…[truncated]'
          : priorAttemptOutput
      lines.push(capped)
      lines.push('')
      lines.push(
        'Build on this work — do NOT restart from scratch. Re-read modified files to verify state.'
      )
    }

    // BP-RETRY-REASON-01: retryPhase resets status to 'pending' but keeps the
    // reason. Without telling the agent what the previous verdict was, a retry
    // re-enters the identical trap — most often by rewriting files that were
    // already correct just to move their mtime.
    if (priorFailureReason) {
      lines.push('')
      lines.push(`**⚠️ Previous attempt failed**: ${priorFailureReason}`)
      lines.push(
        'If a file this task covers is already correct, do NOT rewrite it to look busy — ' +
          'list it under `filesVerifiedUnchanged` in the completion block instead. ' +
          'If an acceptance criterion disagrees with the source, record the mismatch in ' +
          '`acceptanceDeviation` rather than forcing the code to match it.'
      )
    }

    // M3.3: the work packet, when the TASKS phase authored one. Placed AFTER the
    // retry context so a retry reads "what went wrong" first and "what you may
    // touch" second — the order in which it has to act on them.
    const packet = renderWorkPacket(task.packetJson, { strict: strictPacket })
    if (packet) {
      lines.push('')
      lines.push(packet)
    }

    // M4.1: gate evidence from the immediately preceding attempt. Last, because
    // on a retry it is the single most important thing in the prompt.
    if (gateFixInstructions) {
      lines.push('')
      lines.push(gateFixInstructions)
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
    const lines = [`# Build Phase Summary`, '', taskLine, '']

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
          bpLog.info(
            `[cancelBlueprint] Stopping ${sessions.size} active session(s) for blueprint ${blueprintId}`
          )
          for (const session of sessions) {
            try {
              await session.stop()
            } catch {
              /* best effort */
            }
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
        try {
          await session.stop()
        } catch {
          /* best effort */
        }
      }
      this.activeBlueprintIds.delete(wsId)
    }
    this.activeSessions.clear()
    this.activeBlueprintIds.clear()
  }
}

export const blueprintBuildService = new BlueprintBuildService()
