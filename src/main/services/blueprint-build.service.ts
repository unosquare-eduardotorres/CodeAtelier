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
import { existsSync } from 'node:fs'
import { basename, isAbsolute, normalize, relative, resolve } from 'node:path'
import log from 'electron-log'
import type { StreamChunk } from './agent-base.service'
import type { AgentStatus } from '../../shared/types'
import { forwardBlueprintChunk } from './blueprint-chunk-forwarder'
import {
  PhaseActivityWatchdog,
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
import { AgentSessionService, type SendOutcome } from './agent-session.service'
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
import { extractFailureMemory, renderFailureMemory } from './blueprint-failure-memory'
import {
  buildGateFixInstructions,
  captureGateBaseline,
  defaultCommandRunner,
  divergedPacketTestFiles,
  isBaselineDiffEmpty,
  MAX_LISTED_PATHS,
  restorePacketTestFiles,
  runGates,
  runWaveCommandGates,
  scanTaskCommitSurvival,
  TASK_ID_IN_SUBJECT,
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
import { getTimeoutTier } from './provider-timeout-tiers'
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
import { blueprintTelemetryRepository } from '../db/repositories/blueprint-telemetry.repository'
import { conversationRepository } from '../db/repositories'
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
import simpleGit from 'simple-git'
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
 * F4 — in-ladder re-runs for an INFRA failure that is safe to re-send. ONE.
 *
 * `runGateLadder` returns the moment a dispatch fails, and only `overload` had a
 * re-run, so a single transport blip burned the task outright: on blueprint
 * 6c4a6a85 T005 died on one transport error at 12:19 and cascade-skipped 11
 * downstream tasks. `isResumeSafeOutcome` already describes exactly this case
 * — the work was never graded and the send may simply be repeated — and it
 * excludes the two outcomes (`context_overflow`, `turn_limit_exhausted`) where
 * repeating the send repeats the failure.
 *
 * One, not two: a second re-run buys little against a provider that is actually
 * down, and every re-run is a full cold session against the task budget.
 */
const INFRA_MAX_RETRIES = 1
/** Short, unlike the overload backoff: a transport blip is not back-pressure. */
const INFRA_RETRY_DELAY_MS = 5_000

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

/**
 * P1 — what KIND of failure this was, decided where the failure is constructed.
 *
 * `failureReason` is free-form prose aimed at a human ('overload',
 * 'no-write-activity', `quality gate failed: ${names}`, `executor error: …`) and
 * the stop-loss appends to it. Any routing that substring-matches it is one
 * reword away from silently sending gate failures down an infra path — a
 * behaviour change with no compile error and no alarm. This field is the
 * machine-readable half, and the prose stays exactly as it is.
 *
 *   - `infra`   — the environment or the transport failed: overload, executor
 *                 error, a stall, a session that died before finishing. The work
 *                 was never graded, so nothing is known about its quality.
 *   - `quality` — the work ran to completion and was judged wanting by the gates.
 *   - `aborted` — the user cancelled. Not a failure of anything; never retry.
 */
export type TaskFailureClass = 'infra' | 'quality' | 'aborted'

/**
 * Classify an abnormal `session.send()` outcome. A total switch over the union,
 * never a substring match — adding a `SendOutcome` member is then a compile
 * error here rather than a silent fall-through to 'infra'.
 */
export function classifySendOutcome(outcome: Exclude<SendOutcome, 'ok'>): TaskFailureClass {
  switch (outcome) {
    case 'aborted':
      return 'aborted'
    case 'overload':
    case 'error':
    case 'context_overflow':
    case 'turn_limit_exhausted':
      return 'infra'
  }
}

/**
 * R5 — may a failed attempt be RESUMED, rather than re-run cold?
 *
 * `failureClass: 'infra'` used to carry this implication in a comment, and a
 * comment does not constrain a caller: `context_overflow` and
 * `turn_limit_exhausted` are infra in the sense that the work was never graded,
 * but they are the two outcomes a resumed session must NOT be handed — resuming
 * re-sends the very transcript that overflowed, so the retry fails the same way
 * and costs a full context to do it. This function is the permit; the class is
 * not.
 *
 * A total switch again, so a new `SendOutcome` member is a compile error rather
 * than an accidental resume. Absent `resumeSafe` on a `TaskResult` means NOT
 * safe: forgetting the field costs a cold retry, which is today's behaviour.
 */
export function isResumeSafeOutcome(outcome: Exclude<SendOutcome, 'ok'>): boolean {
  switch (outcome) {
    case 'overload':
    case 'error':
      return true
    case 'context_overflow':
    case 'turn_limit_exhausted':
    case 'aborted':
      return false
  }
}

/**
 * A1 — the resume-permit decision, as one value.
 *
 * Everything Step 3's call sites need: the persisted session id to resume
 * (absent when the answer is "cold"), and the decline reason for telemetry
 * when it is not. Pure: flag, provider and repository reads are the caller's.
 */
interface ResumeDecision {
  /** True → pass `sessionId` to `session.start()`; false → cold, as today. */
  resume: boolean
  sessionId?: string
  /** One of: not-safe | no-persisted-id | provider-changed | stale | flag-off | poisoned | poisoned-transcript. */
  reason?: ResumeDeclineReason
  /** A1 (Phase 4) — true when this grant came from the cross-restart branch. */
  crossRun?: boolean
}

type ResumeDeclineReason =
  | 'not-safe'
  | 'no-persisted-id'
  | 'provider-changed'
  | 'stale'
  | 'flag-off'
  | 'poisoned'
  | 'poisoned-transcript'

/**
 * A1 — evaluate the resume permit for one retry.
 *
 * The order of checks is the telemetry taxonomy: every decline reason is
 * distinguishable in the report. The permit (`isResumeSafeOutcome`) is
 * re-derived from the failure's `SendOutcome`-shaped reason when available and
 * trusted from `resumeSafe` otherwise — the two agree on every construction
 * site, and the function stays honest even if a caller forgets the field
 * (absent means NOT safe, i.e. cold, which is pre-A1 behaviour).
 */
function evaluateResumePermit(params: {
  outcome: Exclude<SendOutcome, 'ok'> | undefined
  resumeSafe: boolean | undefined
  flagOn: boolean
  persistedSessionId: string | undefined
  /** Spec-service guard: a session resumed after a provider change is invalid. */
  providerUnchanged: boolean
  /** A1-P1 — the failed rung's session ended poisoned (unanswered user turn). */
  sessionPoisoned?: boolean
}): ResumeDecision {
  // Order matters twice over. First, telemetry: a decline's reason must name
  // the FIRST thing that failed, so `not-safe` is only ever reported when a
  // session id exists to be declined — attempt 1 has nothing to resume and
  // declines `no-persisted-id`, which is the truth. Second, rotation:
  // `shouldRotateIdentity` treats `not-safe` as "a transcript must be
  // abandoned", and attempt 1 has no transcript.
  if (!params.flagOn) return { resume: false, reason: 'flag-off' }
  if (!params.persistedSessionId) return { resume: false, reason: 'no-persisted-id' }
  // A1-P1 — poison outranks the safety re-derivation: a poisoned session has
  // an unanswered user turn in its transcript, and resuming it makes the model
  // answer that stale turn instead of the retry. Normally the id is already
  // gone (recordTurnBoundary clears it eagerly), so this is the backstop for
  // the DB-write-failed case and for paths that never ran a turn boundary.
  if (params.sessionPoisoned) return { resume: false, reason: 'poisoned' }
  const safe =
    params.outcome !== undefined ? isResumeSafeOutcome(params.outcome) : params.resumeSafe === true
  if (!safe) return { resume: false, reason: 'not-safe' }
  if (!params.providerUnchanged) return { resume: false, reason: 'provider-changed' }
  return { resume: true, sessionId: params.persistedSessionId }
}

/**
 * A1 — the resume-side decline when a resumed turn fails to re-attach and the
 * ladder falls back to cold inside the same attempt. Surfaced in telemetry as
 * `stale` — the persisted id existed but the CLI/server would not take it.
 */
function resumeFallbackDecision(): ResumeDecision {
  return { resume: false, reason: 'stale' }
}

/**
 * A1 — does THIS denial warrant rotating the conversation identity?
 *
 * Rotation exists for one reason: a transcript exists that the retry must NOT
 * inherit (it overflowed, it belonged to another provider, or the backend
 * refused to re-attach to it). `no-persisted-id` and `flag-off` denote the
 * ABSENCE of anything to abandon — rotating there would churn identity (and
 * the conversation row) for nothing, so identity stays stable and the retry
 * runs cold on the same row, exactly as pre-A1.
 */
function shouldRotateIdentity(decision: ResumeDecision): boolean {
  return (
    !decision.resume &&
    (decision.reason === 'not-safe' ||
      decision.reason === 'provider-changed' ||
      decision.reason === 'stale' ||
      decision.reason === 'poisoned' ||
      decision.reason === 'poisoned-transcript')
  )
}

/**
 * A1 (Phase 2, G7) — the short continuation message sent into a RESUMED session
 * instead of the full cold task context. Pure so it is unit-testable without
 * a session.
 *
 * The resumed session already contains the task statement, the spec/plan
 * artifacts, the agent's own prior work and (if the flag is on) the failure
 * memory — re-sending any of it is a duplicate of the transcript tail. What
 * the session does NOT contain is the verdict of the failure that triggered
 * this retry, so that — and only that — is what this message carries.
 */
export function buildResumeContinuationMessage(params: {
  taskId: string
  /** 1-based attempt this continuation is sent on. */
  attempt: number
  /** Why the previous rung failed (session outcome, throw message, or gate reason). */
  failureReason?: string | null
  /** Mechanical gate-failure instructions for the retry (M4.1), when present. */
  gateFixInstructions?: string
}): string {
  const lines: string[] = [
    `**Task ${params.taskId} — retry (attempt ${params.attempt})**`,
    '',
    'You are continuing this task in the SAME session — the full task statement,',
    'the spec and plan artifacts, and your prior work are already in this',
    'conversation. Do NOT restart the task and do NOT restate it.',
    '',
    'The previous attempt ended with:'
  ]
  if (params.failureReason) {
    lines.push(`- Failure: ${params.failureReason}`)
  }
  if (params.gateFixInstructions) {
    lines.push('', params.gateFixInstructions)
  }
  lines.push(
    '',
    'Continue from where the transcript stops. Re-read the files you already',
    'touched to re-establish state, then finish the remaining work.',
    'When done, emit a `blueprint-phase-complete` block with phase: "build".'
  )
  return lines.join('\n')
}

/** Return type for executeTask, including timing data. */
interface TaskResult {
  success: boolean
  completion: Record<string, unknown> | null
  discoveries: string[]
  timing?: TaskTiming
  /** When success=false, the reason for failure (session outcome or 'no-write-activity'). */
  failureReason?: string
  /** P1 — the machine-readable companion to `failureReason`. See `TaskFailureClass`. */
  failureClass?: TaskFailureClass
  /**
   * R5 — whether this failure may be retried by RESUMING the session instead of
   * starting a cold one. Never inferred from `failureClass`: see
   * `isResumeSafeOutcome`. Absent means NOT safe (a cold retry, as today).
   */
  resumeSafe?: boolean
  /** How the task closed — persisted so a reload still explains the outcome. */
  outcomeKind?: BlueprintTaskOutcomeKind
  /** Verdict of the deterministic gates for the final attempt, when they ran. */
  gateReport?: GateReport
  /**
   * A11 — how many overload re-runs the gate ladder spent on this task.
   * Absent when none. The schedulers read it at settle time to halve their
   * parallel cap: overload retries now happen inside `executeTaskWithGates`,
   * so without this signal the schedulers never learn the provider is
   * saturated and keep dispatching at full width — which causes more overload.
   */
  overloadCount?: number
  /**
   * A1 (Phase 0) — the LIVE session id at turn end, read synchronously from
   * the session map in `executeTask`'s finally BEFORE the fire-and-forget
   * `stop()` can tear down and clear it. This — not a DB read racing the
   * teardown — is what the next rung's permit is evaluated against.
   * `undefined` when the map already dropped the id (poisoned turn).
   */
  resumableSessionId?: string
  /**
   * A1 (Phase 0) — the DB-derived attempt number this rung ran under (the
   * same number `turn_usage.attempt` records). The ladder's loop counter
   * never advances on overload/infra re-runs, so this is the only attempt
   * number that joins against per-attempt telemetry.
   */
  executeAttempt?: number
  /** A1 (Phase 1) — the session ended POISONED (aborted or zero-chunk turn). */
  sessionPoisoned?: boolean
  /**
   * A1 (Phase 3) — what the executor ACTUALLY did with the requested resume:
   * `resumed` (--resume honoured, same id back), `mismatched` (server handed
   * back a different id), `blocked` (poisoned/malformed id, flag dropped) or
   * `none`. A granted permit that ends up anything but `resumed` is a silent
   * cold run and is telemetered as such.
   */
  resumeOutcome?: 'resumed' | 'mismatched' | 'blocked' | 'none'
  /** A1 (Phase 3) — cache-read tokens for this rung, from the meta chunk. */
  cacheReadInputTokens?: number
  /**
   * A1 (Phase 1) — resolves when this rung's session teardown (stop/kill)
   * completes. Fire-and-forget for the rung itself; the ladder AWAITS it
   * only before dispatching a RESUMED rung, so the new `--resume` spawn
   * never races the old child's kill ("never two processes on one id").
   */
  teardown?: Promise<void>
  /**
   * A1 — the raw `SendOutcome` of a failed attempt, when the session reported
   * one. `resumeSafe` is the permit; this is the EVIDENCE the ladder re-derives
   * the permit from on the next rung, so a resume decision never depends on a
   * stale boolean alone.
   */
  sendOutcome?: Exclude<SendOutcome, 'ok'>
}

/**
 * P0 — write activity accumulated across every attempt of ONE task.
 *
 * `executeTask`'s own counters are locals, reset on each call, so they describe
 * an ATTEMPT. That is the right scope for a cold ladder, where each attempt
 * redoes the work from scratch, and the wrong scope for anything that continues
 * a previous attempt: a session resumed after a stall already wrote its files
 * and correctly emits a completion claiming them with zero write-tool calls.
 * Owned by `executeTaskWithGates` — one box per task, shared by the builder
 * ladder, the overload re-runs, the peer-review fix and the lead escalation.
 */
interface TaskWriteActivity {
  writeToolCalls: number
  bashCalls: number
  /**
   * F1 (step 2) — every path a write-capable tool call named, across all
   * attempts. Handed to the gates as `GateTaskContext.writtenPaths`, where it
   * defeats the peer exemption for paths this task actually wrote.
   */
  writtenPaths: Set<string>
}

/**
 * The paths a FAILING `test-integrity` verdict named, in the machine-readable
 * form (`GateResult.files`) rather than the prose. A passing gate, or a failure
 * of any other gate, names nothing — in particular a file the builder
 * legitimately EXTENDED passes and is never in this list.
 */
function failedTestIntegrityFiles(report: GateReport): readonly string[] {
  return report.gates.find((g) => g.name === 'test-integrity' && g.verdict === 'fail')?.files ?? []
}

/** What one task's whole gate ladder needs, from dispatch through escalation. */
interface TaskLadderParams {
  task: BlueprintTask
  blueprintId: string
  workspaceId: string
  workspacePath: string
  executionPath: string
  phaseContext: import('../../shared/blueprint-types').PhaseContext
  priorDiscoveries: string[]
  tDispatch: number
  waveNum: number
  /** P1a: every task in the blueprint, for peer-file exemption. */
  peers?: readonly BlueprintTask[]
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

/**
 * F1 (step 2) — the file a write-capable tool call targeted, or null.
 *
 * The counters beside this answer "did the task write ANYTHING"; the gates need
 * "did the task write THIS path", because that is the one thing that separates a
 * peer writing its own file from this task writing into a peer's file. Without
 * it the write-set gate can only report `unverifiable` for any changed path a
 * peer declares.
 *
 * `toolInputRaw` is preferred over `toolInput`: on the CLI backend the latter is
 * a display summary ("src/a.ts (1 lines)"), not JSON (see
 * StreamChunk.toolInputRaw). Key spellings match extractStructuredMeta's, plus
 * `notebook_path` for NotebookEdit. Anything unparseable yields null — the
 * absence of a path only costs the weaker verdict, never a wrong one.
 */
export function writeToolTargetPath(chunk: {
  toolName?: string
  toolInput?: string
  toolInputRaw?: string
}): string | null {
  if (!chunk.toolName || !isWriteTool(chunk.toolName)) return null
  const raw = chunk.toolInputRaw ?? chunk.toolInput
  if (!raw) return null
  let input: Record<string, unknown>
  try {
    input = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const candidate =
    input.file_path ?? input.filePath ?? input.notebook_path ?? input.path ?? input.filename
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null
}

/**
 * FIX-2 / P0 — should this task hard-fail as a stale-file claim?
 *
 * The rule it enforces: a completion that claims files while the TASK invoked no
 * write-capable tool and no Bash is describing a prior run's output, not this
 * one (the R029 hole).
 *
 * Two things make it task-scoped rather than attempt-scoped, and both matter:
 *
 * - The counters are cumulative across every attempt. A session resumed after a
 *   stall already wrote its files and legitimately emits a completion claiming
 *   them with zero write-tool calls of its own; per-attempt counters read that
 *   as fabrication and fail work that is on disk.
 * - `baselineDiffEmpty` overrides the counters when it says something changed.
 *   The gate baseline is captured once, before attempt 1, with pre-existing
 *   dirt and peers' files subtracted — so a non-empty diff is a direct
 *   measurement of this task's work, where a tool counter is only a proxy for
 *   it. `null` (git could not answer) is absence of evidence, not evidence of
 *   absence: the counters decide, exactly as they did before.
 */
export function shouldFailForNoWriteActivity(input: {
  /** Write-tool calls across every attempt of this task. */
  cumulativeWriteToolCalls: number
  /** Bash calls across every attempt of this task. */
  cumulativeBashCalls: number
  /** Files the completion says it created or modified. */
  claimedFiles: number
  hasCompletion: boolean
  hasPlannedFiles: boolean
  /** true = nothing changed, false = something did, null = git could not answer. */
  baselineDiffEmpty: boolean | null
}): boolean {
  const noWriteActivity = input.cumulativeWriteToolCalls === 0 && input.cumulativeBashCalls === 0
  if (!noWriteActivity) return false
  const claimsWithoutWork =
    input.claimedFiles > 0 || (!input.hasCompletion && input.hasPlannedFiles)
  if (!claimsWithoutWork) return false
  return input.baselineDiffEmpty !== false
}

/**
 * GLM-PROTOCOL-MISS-01 — "wrote but didn't sign" predicate.
 *
 * A task whose verification came back all-zero (no completion block, no
 * missing/stale claims, every checkable planned file present) still has a
 * story to tell: the model may have DONE the work (write tools fired, files
 * landed) and simply skipped the ```blueprint-phase-complete handshake.
 * Direct write activity + planned files present is the same evidence the
 * BP-VERIFY-UNPROVEN-01 branch trusts, so this shape passes as `unproven`
 * instead of burning MAX_BUILDER_ATTEMPTS identical retries on a stochastic
 * protocol miss. Zero-write tasks return false here and hard-fail in
 * `shouldFailForNoWriteActivity`, exactly as before.
 */
export function shouldPassProtocolMissAsUnproven(input: {
  /** Verification found no discrepancy it could name (no completion block path). */
  allZero: boolean
  /** Write-tool calls across every attempt of this task. */
  cumulativeWriteToolCalls: number
  /** Bash calls across every attempt of this task. */
  cumulativeBashCalls: number
  /** The task has planned filePathsJson entries to point at. */
  hasPlannedFiles: boolean
}): boolean {
  if (!input.allZero) return false
  if (input.cumulativeWriteToolCalls === 0 && input.cumulativeBashCalls === 0) return false
  return input.hasPlannedFiles
}

/**
 * GLM-PROTOCOL-MISS-04 — poisoned-transcript signature for ONE rung.
 *
 * The rung failed with a protocol-miss failureReason (model never emitted the
 * required ```blueprint-phase-complete fence), the failure was not an
 * executor/transport error in disguise, and the rung added zero write
 * activity (writesAfter === writesBefore). Pure predicate, exported for the
 * truth-table tests; the ladder folds it into the consecutive-miss streak.
 */
export function isProtocolMissRung(input: {
  success: boolean
  failureReason?: string
  /** Cumulative write activity (writeToolCalls + bashCalls) at rung start. */
  writesBefore: number
  /** Cumulative write activity after the rung settled. */
  writesAfter: number
}): boolean {
  if (input.success) return false
  const reason = input.failureReason ?? ''
  if (!reason.includes('protocol miss')) return false
  if (reason.startsWith('executor error:')) return false
  return input.writesAfter === input.writesBefore
}

/** Check whether two file sets overlap. */
function filesOverlap(a: Set<string>, b: Set<string>): boolean {
  for (const f of a) {
    if (b.has(f)) return true
  }
  return false
}

/**
 * A6 — build the enforced per-task commit subject: `feat: <description> (<taskId>)`.
 *
 * The shape is a CONTRACT, not a preference: `scanTaskCommitSurvival` attributes
 * commits to tasks by matching `TASK_ID_IN_SUBJECT` (imported, never duplicated)
 * against the subject, and the per-attempt destructive-revert gate + L3
 * reconciliation both lean on that attribution. Exported so the unit test can
 * assert the two can never drift apart.
 */
export function buildTaskCommitSubject(input: { taskId: string; description: string }): string {
  const type = 'feat' // BlueprintTask carries no type field — fixed prefix, no dead knob
  const desc = input.description.replace(/\s+/g, ' ').trim().slice(0, 72)
  const subject = `${type}: ${desc} (${input.taskId})`
  if (!TASK_ID_IN_SUBJECT.test(subject)) {
    // Defensive: a task id that cannot match the scan's pattern would make the
    // commit invisible to attribution — better an explicit error than a silent
    // unverifiable gate.
    throw new Error(
      `buildTaskCommitSubject: taskId "${input.taskId}" does not match TASK_ID_IN_SUBJECT — cannot build an attributable commit subject`
    )
  }
  return subject
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
      const prefs = appPreferenceRepository.getAppPreferences()
      const dagEnabled = prefs.dagScheduling

      // Which settings produced this run. Without it, comparing two runs is manual
      // bookkeeping — and a comparison across runs with different task counts
      // *looks* measured while measuring nothing.
      //
      // Recorded on ENTRY, not at completion: the `kind: 'scheduler'` row below
      // only fires when the build finishes, so a crashed or aborted run would
      // carry no attribution at all — and those are precisely the runs worth
      // tuning from. `verifyFeatureDiff` is captured here even though it is a
      // VERIFY flag: this is a run-configuration snapshot, and flipping it
      // mid-run is pathological. The backend is deliberately NOT duplicated —
      // it lives on `turn_usage` (A4) and is reached by joining on blueprint_id;
      // a second copy would only invite the two to disagree.
      blueprintTelemetryRepository.record({
        blueprintId,
        kind: 'config',
        phase: 'build',
        data: {
          dagScheduling: prefs.dagScheduling,
          parallelBuildAgents: prefs.parallelBuildAgents,
          leanBuildMcp: prefs.leanBuildMcp,
          blueprintAutoMode: prefs.blueprintAutoMode,
          verifyFeatureDiff: prefs.verifyFeatureDiff,
          totalTasks,
          totalWaves: sortedWaves.length
        }
      })
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
          allTasks,
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
            allTasks,
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

      // P3a — reconcile the record against the tree before anything downstream
      // trusts "N/N complete". Skipped when the build already failed: that
      // failure is already reported, and a half-built tree has nothing to say.
      if (!result.failed) {
        try {
          await this.reconcileBuildOutput({
            blueprintId,
            workspaceId,
            executionPath,
            allTasks,
            result
          })
        } catch (reconcileErr) {
          // Best effort by design: reconciliation is a check ON the build, and a
          // crash in the checker must not fail a build that was otherwise fine.
          bpLog.warn('[reconcile] Reconciliation pass threw (non-fatal):', reconcileErr)
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

      // E11 — SchedulerStats was in-memory only, attached to the BuildResult and
      // to the build artifact above. That makes it readable for ONE run at a time
      // and only through the artifact blob; a queryable row is what turns
      // "did parallelism actually help?" into something answerable across runs.
      if (result.scheduler) {
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'scheduler',
          phase: 'build',
          data: {
            mode: result.scheduler.mode,
            drainCount: result.scheduler.drainCount,
            maxParallelism: result.scheduler.maxParallelism,
            parallelismHistogram: result.scheduler.parallelismHistogram,
            perTaskWaitMs: result.scheduler.perTaskWaitMs,
            ...(result.scheduler.fallbackReason
              ? { fallbackReason: result.scheduler.fallbackReason }
              : {}),
            totalTasks,
            tasksCompleted: result.tasksCompleted,
            failed: result.failed
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
        //
        // B3 note, deliberate: a task that tripped the stop-loss carries its
        // whole clause in `reason`, so ~120 chars of "stop-loss after N identical
        // gate failure(s)" ride into `saveRetryContext.error` and reach the NEXT
        // build attempt's context. Kept: telling the retry that the previous run
        // failed the same gate repeatedly is exactly what stops it re-running the
        // same approach. It also feeds F4's phase-level recurrence fingerprint,
        // where a stable clause makes consecutive identical failures compare
        // equal instead of drifting.
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
   * Backoff before an overload re-dispatch: 60 s, then 120 s.
   *
   * A method rather than the inline expression it replaces at both scheduler
   * sites, so a test can shorten it per-instance. The alternative — swapping
   * `globalThis.setTimeout` because `abortAwareSleep` is module-level — reaches
   * every concurrently-awaited suite in the same process, including the 30-min
   * task timeout armed by the real `executeTask`.
   */
  protected overloadBackoffMs(attempt: number): number {
    return OVERLOAD_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
  }

  /**
   * F4 — pause before the infra re-run. A method for the same reason
   * `overloadBackoffMs` is one: it is the only seam a test can shorten without
   * swapping module-level `setTimeout`, which would reach every concurrently
   * awaited suite in the process.
   */
  protected infraRetryDelayMs(): number {
    return INFRA_RETRY_DELAY_MS
  }

  /**
   * A11 — scheduler back-pressure after a task saw an API overload: halve the
   * parallel cap, floor 1. Applied at most once per task.
   *
   * A method rather than two inline expressions for the same reason
   * `overloadBackoffMs` is one: overload retries moved into the gate ladder, so
   * back-pressure is the only overload logic the schedulers still own, and it
   * has to stay identical in both of them (§1.2's "both schedulers or neither").
   * It is also the only seam a test can observe — `cap` is a loop-local.
   */
  protected halveCapOnOverload(cap: number, scheduler: string, taskId: string): number {
    if (cap <= 1) return cap
    const newCap = Math.max(1, Math.floor(cap / 2))
    bpLog.warn(
      `[${scheduler}] Task ${taskId} hit API overload — ` +
        `reducing parallel cap from ${cap} to ${newCap}`
    )
    return newCap
  }

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
    /** P1a — every task in the blueprint, for gate-time peer-file exemption. */
    allTasks: BlueprintTask[]
    blueprintId: string
    workspaceId: string
    /** Workspace identity — the primary tree. Never a cwd. */
    workspacePath: string
    /** Where the agents write (run worktree or primary tree). */
    executionPath: string
    phaseContext: import('../../shared/blueprint-types').PhaseContext
    result: BuildResult
  }): Promise<void> {
    const {
      dag,
      allTasks,
      blueprintId,
      workspaceId,
      workspacePath,
      executionPath,
      phaseContext,
      result
    } = params
    const stats = result.scheduler!

    // Build-scoped cap (clamped 1–6, default 3). Mutable — halved on overload.
    let cap = appPreferenceRepository.getAppPreferences().parallelBuildAgents

    const inFlight = new Map<string, InFlightEntry>()
    const dispatched = new Set<string>()
    const terminal = new Set<string>() // settled this run: complete/failed/user-skipped
    let exclusiveInFlight = false
    let draining = false
    /** A11 — tasks whose cap-halving has already been applied (once per task). */
    const overloadSeen = new Set<string>()
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
        peers: allTasks,
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

      // A11 — overload is retried INSIDE `executeTaskWithGates` now, so by the
      // time a task settles here its overload retries are already spent and the
      // result has been graded. What the scheduler still owns is back-pressure:
      // halve the cap once per task that saw an overload, or the loop keeps
      // dispatching at full width into a saturated provider and manufactures
      // more of them. The re-dispatch branch that used to live here bypassed the
      // gate ladder entirely — see `executeTaskWithGates`.
      if ((settled.taskResult.overloadCount ?? 0) > 0 && !overloadSeen.has(settled.taskId)) {
        overloadSeen.add(settled.taskId)
        cap = this.halveCapOnOverload(cap, 'executeDag', settled.taskId)
      }

      // A6-fix — hoisted ABOVE handleTaskCompletion: the enforced per-task
      // commit intersects dirty paths with the task's own claims, and the
      // agent's reported filesModified IS one of those claim sources.
      const reportedModified = asStringArray(settled.taskResult.completion?.filesModified)

      await this.handleTaskCompletion({
        task: settled.entry.task,
        taskResult: settled.taskResult,
        blueprintId,
        workspaceId,
        waveNum: settled.entry.task.wave,
        result,
        executionPath,
        workspacePath,
        reportedFiles: reportedModified
      })
      terminal.add(settled.taskId)
      completionsSinceGate++
      markComplete(dag, settled.taskId)

      if (settled.taskResult.success) {
        if (reportedModified.length > 0) {
          reportedFiles.set(settled.taskId, normalizePaths(reportedModified))
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
    /**
     * P1a — every task in the BLUEPRINT, not just this wave: a task in an
     * earlier wave has finished and its files are still not this task's to write.
     */
    allTasks: BlueprintTask[]
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
      allTasks,
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
    /** A11 — tasks whose cap-halving has already been applied (once per task). */
    const overloadSeen = new Set<string>()

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
                peers: allTasks,
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
            peers: allTasks,
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
            peers: allTasks,
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

      // A11 — overload retries live in `executeTaskWithGates` now, so a task that
      // settles here has already spent them and has been graded. The scheduler
      // keeps only the back-pressure half: halve the cap once per task that saw
      // an overload. §1.2's "both schedulers or neither" duplication is closed by
      // construction — the retry logic exists once, in the ladder both call.
      if ((settled.taskResult.overloadCount ?? 0) > 0 && !overloadSeen.has(settled.taskId)) {
        overloadSeen.add(settled.taskId)
        cap = this.halveCapOnOverload(cap, 'executeWave', settled.taskId)
      }

      // A6-fix — hoisted above handleTaskCompletion for the same reason as
      // executeDag: the commit needs the settled task's own claims at settle time.
      const reportedModified = asStringArray(settled.taskResult.completion?.filesModified)

      await this.handleTaskCompletion({
        task: settled.entry.task,
        taskResult: settled.taskResult,
        blueprintId,
        workspaceId,
        waveNum,
        result,
        executionPath,
        workspacePath,
        reportedFiles: reportedModified
      })

      // H2 FIX: Collect reported filesModified for post-wave overlap detection.
      // R2 FIX: Guard via asStringArray — LLM may emit a string, object, or mixed array.
      if (settled.taskResult.success) {
        if (reportedModified.length > 0) {
          reportedFiles.set(settled.taskId, normalizePaths(reportedModified))
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
    /** P1a — every task in the blueprint, for gate-time peer-file exemption. */
    peers: readonly BlueprintTask[]
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
      peers,
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
      // P1a: every task in the blueprint, so gate-time attribution can exempt
      // peer tasks' declared files from this task's diff — whether those peers
      // are pending, running or already finished.
      peers
    })

    inFlight.set(task.taskId, { promise, files: taskFiles, task })
  }

  // ── Gate loop & escalation ladder (M2.8 / M4) ──

  /**
   * Run a task, then grade it with the deterministic gates, retrying on `fail`.
   *
   * The ladder is bounded by construction — worst case per task is
   * MAX_BUILDER_ATTEMPTS builder runs, OVERLOAD_MAX_RETRIES overload re-runs and
   * one lead-model fix = **6 executions**:
   *
   *   attempt 1 → gates fail → attempt 2 (with evidence) → gates fail
   *     → attempt 3 (with evidence) → gates fail → lead model fixes → gates fail
   *     → task failed, phase hard-holds on the existing failure machinery.
   *
   * Six is accepted rather than capped. An overload is infrastructure telling us
   * to come back later, not the builder failing; capping the total would convert
   * a recoverable run into a hard failure for a reason that has nothing to do
   * with the code. The overload re-runs consume no builder attempt.
   *
   * A11 — **overload is retried HERE, inside the ladder.** Both schedulers used
   * to intercept `failureReason === 'overload'` at settle time and re-dispatch
   * through `executeTask` directly, bypassing this method entirely: a task that
   * hit one overload and then succeeded was marked complete with no gate
   * grading, no peer review and no escalation, and `handleTaskCompletion`
   * stamped it `outcomeKind: 'verified'` — a claim nothing had checked. Retrying
   * inside the same loop iteration means the retried execution is graded against
   * the same `baseline` by the same ladder as any other.
   *
   * The contract the schedulers still depend on: when overload retries are
   * exhausted this returns **exactly** `failureReason: 'overload'`, which
   * `executeWave`'s drain check compares on equality.
   *
   * **Known consequence — the ladder cannot see `draining`.** The old scheduler
   * branch guarded on `!draining`, so once a peer task had failed and the wave
   * was draining, an overloading task failed immediately. `draining` is a
   * scheduler local and the ladder takes no new parameter for it, so such a task
   * now spends its backoff (up to 60 s + 120 s) before settling, and a drain can
   * take that much longer. Accepted deliberately, on the same reasoning as the
   * 6-execution bound: the drain was triggered by a DIFFERENT task's failure, and
   * failing this one for a provider overload it might well recover from is a hard
   * failure for an unrelated reason. **User abort is not affected** — the backoff
   * sleeps on `getAbortSignal(workspaceId)` and settles as `'aborted'`.
   *
   * `unverifiable` never enters the ladder: it is recorded in the ledger, warned
   * about, and the task advances. That is the invariant the whole stack rests on.
   */
  private async executeTaskWithGates(params: TaskLadderParams): Promise<TaskResult> {
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
      // This blueprint's artifact dir only — the pipeline rewrites plan/tasks/
      // spec there mid-task, but a sibling blueprint's artifacts are still a
      // write-set violation.
      artifactPrefix: params.phaseContext.blueprintDir,
      // P2a: `lint` still runs once per WAVE on the settled tree (13,991 ms,
      // and it measures peers' mid-flight edits when run per task). `build` is
      // per-task: 3,751 ms against a mean task time of 285 s, and it is the
      // only thing standing between a broken import and four tasks built on it.
      commandGates: ['build']
    }
    this.refreshExemptFiles(gateCtx, params.peers)

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

    // P1 — the tree-driven net around the whole ladder. In `finally` so a THROW
    // is swept too: a session that damaged a packet test file and then died is
    // exactly the exit that used to leave the damage on disk, where the
    // operator's next Retry absorbs it as the new baseline.
    let outcome: TaskResult | null = null
    try {
      outcome = await this.runGateLadder(params, gateCtx, baseline)
      return outcome
    } finally {
      if (baseline && !outcome?.success) {
        this.sweepPacketTestDamage(gateCtx, baseline, {
          blueprintId,
          workspaceId,
          taskId: task.taskId
        })
      }
    }
  }

  /**
   * The retry ladder itself: builder attempts, the B3 stop-loss and the
   * escalation rung.
   *
   * Split out of `executeTaskWithGates` so the baseline capture and the
   * post-ladder sweep can bracket it. The sweep needs ONE exit point, and the
   * ladder has five returns plus a throw path.
   */
  private async runGateLadder(
    params: TaskLadderParams,
    gateCtx: GateTaskContext,
    baseline: GateBaseline | null
  ): Promise<TaskResult> {
    const { task, blueprintId, workspaceId, workspacePath } = params

    // P0 — one box per TASK, deliberately outside the attempt loop. See
    // `TaskWriteActivity`: the per-attempt counters inside `executeTask` cannot
    // answer "did this task write anything" once an attempt continues another.
    const writeActivity: TaskWriteActivity = {
      writeToolCalls: 0,
      bashCalls: 0,
      writtenPaths: new Set<string>()
    }

    // Evaluated lazily and only on the guard path (a completion claiming files
    // with no write activity), which is rare — the happy path never pays for the
    // git diff. Returns null when git cannot answer, and the guard treats that
    // as "no evidence" rather than as "nothing changed".
    const baselineDiffEmpty = baseline
      ? (): Promise<boolean | null> => isBaselineDiffEmpty(gateCtx, baseline)
      : undefined

    /** Shared by every rung of the ladder so write activity accumulates across them. */
    const ladderParams = {
      ...params,
      writeActivity,
      baselineDiffEmpty,
      /** A1 — current identity generation; kept in sync by rotateGeneration(). */
      taskGeneration: 0
    }

    let gateFixInstructions: string | undefined
    let lastResult: TaskResult | null = null
    /** B3 — fingerprint of the previous attempt's gate failure, for the stop-loss. */
    let lastFingerprint = ''
    /** How many attempts IN A ROW have produced `lastFingerprint` (1 = just this one). */
    let repeatCount = 0
    /** B3 — set when the stop-loss trips, carried out on the returned TaskResult. */
    let stopLossNote = ''
    /** A11 — overload re-runs spent so far, across the whole ladder. */
    let overloadRetries = 0
    /** F4 — infra re-runs spent so far, across the whole ladder. */
    let infraRetries = 0
    /**
     * GLM-PROTOCOL-MISS-04 — poisoned-transcript escape state. A rung whose
     * failure reason carries the protocol-miss signature increments this WHEN
     * it also added zero write activity to the shared box; any other outcome
     * (success, different failure, new writes) resets it. ≥1 at decideResume
     * time forces a fresh session instead of resuming the transcript that
     * produced the identical failure.
     */
    let consecutiveProtocolMisses = 0
    let writesAtLastRungStart = 0
    /**
     * A1 — the task's conversation identity, stable across attempts. Attempts
     * that resume keep this id (and with it the persisted session id); attempts
     * that must not resume (permit denied: `context_overflow`,
     * `turn_limit_exhausted`, provider change) rotate the generation suffix and
     * get a genuinely fresh conversation. `Date.now()` in the old id meant every
     * attempt was a new conversation by construction, so nothing could ever be
     * resumed — this is what turns the F4 permit into a mechanism.
     */
    let taskGeneration = 0
    /**
     * A1 — set when the rung that just failed may be resumed. Read by the next
     * `executeTask` call to decide resume vs cold before the retry dispatches.
     */
    let resumeOutcome: Exclude<SendOutcome, 'ok'> | undefined
    let resumePermitted = false
    /**
     * A1 — true when the rung that just ran was itself a resume. If that rung
     * STILL failed at the session level, the persisted id is stale (dead
     * CLI transcript / restarted OpenCode server) and the next rung must fall
     * back to cold — recorded as decline reason `stale`. This is the "resume
     * failure falls back to cold, no budget burned" guarantee: the fallback
     * rides the SAME retry the ladder was already going to spend.
     */
    let lastRungResumed = false
    /**
     * A1 (Phase 0) — the previous rung's resume substrate, captured in ITS
     * finally before teardown. This — not a DB read racing stop() — is what
     * the next permit is evaluated against. `undefined` also carries meaning:
     * the session map already dropped the id (poisoned turn).
     */
    let prevResumableSessionId: string | undefined
    /** A1 (Phase 1) — the previous rung's session ended poisoned. */
    let prevSessionPoisoned: boolean | undefined
    /** A1 (Phase 4) — attempt-1 cross-restart resume is allowed by the caller. */
    const allowCrossRun = true
    /** A1 (Phase 0) — the previous rung's DB-derived attempt number. */
    let prevExecuteAttempt: number | undefined
    /** A1 (Phase 1) — the previous rung's teardown promise, awaited before a resumed dispatch. */
    let resultTeardown: Promise<void> | undefined
    /**
     * A1 (Phases 0+3) — fold a rung's TaskResult into the ladder's decision
     * state + honest telemetry. One place, so the three executeTask call
     * sites (ladder, overload loop, F4 loop) cannot drift apart again.
     * GAP-B: the GLM-PROTOCOL-MISS-04 streak update lives HERE — it is the
     * single fold-point every rung result already passes through, so the
     * overload and F4 re-run results update it too (they never did before).
     */
    const recordRungEvidence = (
      result: TaskResult,
      decision: ResumeDecision,
      attempt: number
    ): void => {
      resumeOutcome = result.sendOutcome
      resumePermitted = result.resumeSafe === true
      lastRungResumed = decision.resume
      prevResumableSessionId = result.resumableSessionId
      prevSessionPoisoned = result.sessionPoisoned
      prevExecuteAttempt = result.executeAttempt
      resultTeardown = result.teardown
      // GLM-PROTOCOL-MISS-04 — update the poisoned-transcript escape state.
      // Signature match: the rung's failureReason names the protocol miss AND
      // the rung added no write activity since the last rung started. Both
      // required — a protocol miss WITH new writes is the recoverable kind
      // (and usually passes via the "wrote but didn't sign" branch), and a
      // different failure resets the streak.
      const rungWrites = writeActivity.writeToolCalls + writeActivity.bashCalls
      if (
        isProtocolMissRung({
          success: result.success,
          failureReason: result.failureReason,
          writesBefore: writesAtLastRungStart,
          writesAfter: rungWrites
        })
      ) {
        consecutiveProtocolMisses++
        bpLog.warn(
          `[executeTaskWithGates] ${task.taskId} — consecutive protocol-miss failure with ` +
            `zero new write activity (streak: ${consecutiveProtocolMisses}); next retry will ` +
            `start a fresh session (poisoned-transcript escape)`
        )
      } else {
        consecutiveProtocolMisses = 0
      }
      writesAtLastRungStart = rungWrites
      if (decision.resume && result.success) {
        // A1 (Phase 3) — the rung succeeded, but did the executor actually
        // RESUME? A granted permit that the executor dropped (poisoned id,
        // malformed id) or that the server re-issued (mismatch) was a silent
        // COLD run — recorded as `failed-silently`, never as `succeeded`.
        const actual = result.resumeOutcome ?? 'none'
        if (actual === 'resumed') {
          this.recordResumeTelemetry(
            { blueprintId, taskId: task.taskId, attempt, executeAttempt: result.executeAttempt },
            'succeeded',
            {
              sessionId: decision.sessionId,
              generation: taskGeneration,
              ...(result.cacheReadInputTokens !== undefined
                ? { cacheReadInputTokens: result.cacheReadInputTokens }
                : {})
            }
          )
        } else {
          this.recordResumeTelemetry(
            { blueprintId, taskId: task.taskId, attempt, executeAttempt: result.executeAttempt },
            'failed-silently',
            {
              sessionId: decision.sessionId,
              generation: taskGeneration,
              silentReason: actual,
              ...(result.cacheReadInputTokens !== undefined
                ? { cacheReadInputTokens: result.cacheReadInputTokens }
                : {})
            }
          )
        }
      }
    }
    /** A1 — provider snapshot taken before attempt 1; a change invalidates resume. */
    const ladderProvider = modelConfigService.getProvider(workspacePath)
    /**
     * A1 — rotate the identity generation and keep `ladderParams` in sync, so
     * the cold rungs that spread it (peer-review fix, lead escalation) run
     * under the CURRENT generation's conversation id — cold by design (fresh
     * reasoning, different model), never resuming, but never writing their
     * turns onto a stale generation's row either.
     */
    const rotateGeneration = (): number => {
      taskGeneration++
      ladderParams.taskGeneration = taskGeneration
      return taskGeneration
    }

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

      // A1 — decide resume vs cold for THIS rung before it dispatches. On
      // attempt 1 there is nothing to resume (resumeOutcome unset) and the
      // decision is always cold, exactly as before. On a retry, the permit is
      // evaluated against the previous rung's outcome: resume when safe +
      // persisted id + provider unchanged + flag on; rotate the generation and
      // go cold otherwise. One decision per rung, telemetry either way.
      const resumeDecision: ResumeDecision = await this.decideResume({
        blueprintId,
        taskId: task.taskId,
        attempt,
        convId: `blueprint-build-${blueprintId}-${task.taskId}`,
        generation: taskGeneration,
        outcome: resumeOutcome,
        resumeSafe: resumePermitted,
        providerAtStart: ladderProvider,
        workspacePath,
        previousRungWasResume: lastRungResumed,
        previousResumableSessionId: prevResumableSessionId,
        previousSessionPoisoned: prevSessionPoisoned,
        executeAttempt: prevExecuteAttempt,
        consecutiveProtocolMisses,
        ...(attempt === 1 ? { allowCrossRun } : {})
      })
      if (resumeOutcome !== undefined && shouldRotateIdentity(resumeDecision)) {
        // The denial carries a transcript that must be abandoned — rotate the
        // identity so the cold retry gets a fresh conversation and never
        // re-injects the transcript that produced the denial. Denials that
        // denote ABSENCE (no id, flag off) keep identity stable — see
        // `shouldRotateIdentity`.
        rotateGeneration()
      }
      // A1-P3 — never let a resumed spawn race the previous rung's teardown
      // ("never two processes on one session id"). stop() is bounded by its
      // own 10s deadlock guard, and cold rungs skip the wait entirely, so the
      // dispatch-slot optimisation is preserved where it costs nothing.
      if (resumeDecision.resume && resultTeardown) {
        await resultTeardown
      }
      const rungParams = {
        ...ladderParams,
        gateFixInstructions,
        taskGeneration,
        ...(resumeDecision.resume && resumeDecision.sessionId
          ? {
              resumeSessionId: resumeDecision.sessionId,
              resumeConversationId:
                `blueprint-build-${blueprintId}-${task.taskId}` +
                (taskGeneration > 0 ? `-g${taskGeneration}` : '')
            }
          : {})
      }

      let result = await this.executeTask(rungParams)
      blueprintTaskRepository.recordAttempt(task.id)

      // A1 (Phases 0+3) — carry this rung's evidence forward for the next
      // rung's decision, with honest resume-outcome telemetry. The
      // GLM-PROTOCOL-MISS-04 streak update happens inside (single fold-point,
      // so re-run results are counted too).
      recordRungEvidence(result, resumeDecision, attempt)

      // R1 — the attempt failed before it could be graded. Recorded HERE, not at
      // settle: `handleTaskCompletion` runs once per task, so a task that fails
      // and then succeeds leaves no trace of the attempt that failed — which is
      // the entire population M0 asks about. `attempt` is the loop index, the
      // number the settle-time row cannot give.
      if (!result.success) {
        this.recordAttemptFailure({
          blueprintId,
          taskId: task.taskId,
          attempt,
          waveNum: params.waveNum,
          failureClass: result.failureClass,
          reason: result.failureReason ?? 'unknown'
        })
      }

      // A11 — overload re-run, INSIDE this iteration. No builder attempt is
      // consumed: `attempt` does not advance, `gateFixInstructions` is unchanged
      // (there is no gate feedback to carry — the model never ran), and the
      // captured `baseline` is reused so the diff still describes the state the
      // task started from.
      while (
        !result.success &&
        result.failureReason === 'overload' &&
        overloadRetries < OVERLOAD_MAX_RETRIES
      ) {
        overloadRetries++
        const delay = this.overloadBackoffMs(overloadRetries)
        const totalAttempts = OVERLOAD_MAX_RETRIES + 1
        bpLog.info(
          `[gates] Task ${task.taskId} hit API overload — retry ` +
            `${overloadRetries + 1}/${totalAttempts} after ${delay / 1000}s`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text:
            `⚠ Task ${task.taskId} hit API overload — ` +
            `retrying in ${delay / 1000}s (attempt ${overloadRetries + 1}/${totalAttempts})`,
          kind: 'system'
        })

        // E11 — after the decision is taken and the message is out, never
        // between a dispatch and its settle: better-sqlite3 writes are synchronous.
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'overload',
          phase: 'build',
          taskId: task.taskId,
          attempt,
          data: { overloadRetry: overloadRetries, delayMs: delay, maxRetries: OVERLOAD_MAX_RETRIES }
        })

        try {
          await abortAwareSleep(delay, blueprintService.getAbortSignal(workspaceId) ?? undefined)
        } catch {
          // Aborted during backoff. Report it as such rather than as overload —
          // 'overload' would send the wave scheduler into its drain path with a
          // message blaming the provider for a user cancellation.
          // `resumeSafe` is cleared explicitly: `result` is the overload failure
          // this backoff was waiting out, and it carries a resume permit that
          // must not survive a user cancellation.
          return { ...result, failureReason: 'aborted', failureClass: 'aborted', resumeSafe: false }
        }

        // The backoff is a 60–120 s window — far wider than the dispatch-time gap
        // the exemption logic was built for — so peers have almost certainly
        // written during it. Re-read before the retry, or their files land in
        // this task's diff as write-set violations.
        this.refreshExemptFiles(gateCtx, params.peers)

        // A1 — the overload loop's own permit evaluation: overload is
        // resume-safe, so this resumes whenever the flag is on and the session
        // id survived the failed turn (processMetaChunk persists it from the
        // CLI's init message before overload hits). A denied permit rotates
        // the generation and retries cold, exactly as pre-A1.
        const overloadResume = await this.decideResume({
          blueprintId,
          taskId: task.taskId,
          attempt,
          convId: `blueprint-build-${blueprintId}-${task.taskId}`,
          generation: taskGeneration,
          outcome: 'overload',
          resumeSafe: true,
          providerAtStart: ladderProvider,
          workspacePath,
          previousRungWasResume: lastRungResumed,
          previousResumableSessionId: prevResumableSessionId,
          previousSessionPoisoned: prevSessionPoisoned,
          executeAttempt: prevExecuteAttempt,
          // GAP-B — same escape as the main rung site: a poisoned transcript
          // must not be resumed by the overload re-run either.
          consecutiveProtocolMisses
        })
        if (shouldRotateIdentity(overloadResume)) rotateGeneration()
        // A1-P3 — await the previous rung's teardown before a RESUMED re-run.
        if (overloadResume.resume && resultTeardown) await resultTeardown
        result = await this.executeTask({
          ...ladderParams,
          gateFixInstructions,
          taskGeneration,
          ...(overloadResume.resume && overloadResume.sessionId
            ? {
                resumeSessionId: overloadResume.sessionId,
                resumeConversationId:
                  `blueprint-build-${blueprintId}-${task.taskId}` +
                  (taskGeneration > 0 ? `-g${taskGeneration}` : '')
              }
            : {})
        })
        // Recorded AFTER the call, matching the ladder convention: executeTask
        // reads `attempts` to derive its own attempt number.
        blueprintTaskRepository.recordAttempt(task.id)
        recordRungEvidence(result, overloadResume, attempt)
      }

      // F4 — ONE in-ladder re-run for an infra failure the session outcome says
      // is safe to re-send. Modelled on the A11 overload loop above and, like
      // it, consumes no builder attempt: `attempt` does not advance, there is no
      // gate feedback to carry (the model produced no gradeable work), and the
      // baseline still describes the state the task started from.
      //
      // `overload` is excluded because it has its own loop; reaching here with
      // `failureReason === 'overload'` means that loop is EXHAUSTED, and the
      // wave scheduler compares that string by equality to enter its drain path.
      if (
        !result.success &&
        infraRetries < INFRA_MAX_RETRIES &&
        result.failureClass === 'infra' &&
        result.resumeSafe === true &&
        result.failureReason !== 'overload'
      ) {
        infraRetries++
        const reason = result.failureReason ?? 'unknown'
        const infraDelay = this.infraRetryDelayMs()
        bpLog.warn(
          `[gates] Task ${task.taskId} failed on infrastructure (${reason}) — ` +
            `one re-run in ${infraDelay / 1000}s (no builder attempt consumed)`
        )
        this.safeEmit('phaseProgress', {
          blueprintId,
          workspaceId,
          phase: 'build',
          text:
            `⚠ Task ${task.taskId} hit an infrastructure failure (${reason}) — ` +
            `re-running once in ${infraDelay / 1000}s`,
          kind: 'system'
        })
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'infra_retry',
          phase: 'build',
          taskId: task.taskId,
          attempt,
          data: { reason, failureClass: result.failureClass, delayMs: infraDelay }
        })

        try {
          await abortAwareSleep(
            infraDelay,
            blueprintService.getAbortSignal(workspaceId) ?? undefined
          )
          // The wait is short, but a peer can still land inside it — and an
          // exemption set read before the wait would attribute its writes here.
          this.refreshExemptFiles(gateCtx, params.peers)

          // A1 — F4's re-run becomes a resume when the permit holds. The
          // `error`/verification-exception classes that reach here carry
          // `resumeSafe: true` and a persisted id; a denied permit rotates the
          // generation and re-runs cold, exactly as pre-A1.
          const infraResume = await this.decideResume({
            blueprintId,
            taskId: task.taskId,
            attempt,
            convId: `blueprint-build-${blueprintId}-${task.taskId}`,
            generation: taskGeneration,
            outcome: result.sendOutcome,
            resumeSafe: result.resumeSafe,
            providerAtStart: ladderProvider,
            workspacePath,
            previousRungWasResume: lastRungResumed,
            previousResumableSessionId: prevResumableSessionId,
            previousSessionPoisoned: prevSessionPoisoned,
            executeAttempt: prevExecuteAttempt,
            // GAP-B — same escape as the main rung site: a poisoned transcript
            // must not be resumed by the F4 infra re-run either.
            consecutiveProtocolMisses
          })
          if (shouldRotateIdentity(infraResume)) rotateGeneration()
          // A1-P3 — await the previous rung's teardown before a RESUMED re-run.
          if (infraResume.resume && resultTeardown) await resultTeardown
          result = await this.executeTask({
            ...ladderParams,
            gateFixInstructions,
            taskGeneration,
            ...(infraResume.resume && infraResume.sessionId
              ? {
                  resumeSessionId: infraResume.sessionId,
                  resumeConversationId:
                    `blueprint-build-${blueprintId}-${task.taskId}` +
                    (taskGeneration > 0 ? `-g${taskGeneration}` : '')
                }
              : {})
          })
          blueprintTaskRepository.recordAttempt(task.id)
          recordRungEvidence(result, infraResume, attempt)
        } catch {
          // Cancelled during the wait. Reported as the cancellation it is, and
          // the resume permit is cleared: it belonged to the infra failure this
          // wait was backing off, and must not survive a user cancellation.
          return { ...result, failureReason: 'aborted', failureClass: 'aborted', resumeSafe: false }
        }
      }

      lastResult = result

      // A task that failed its Layer-1 file verification never reaches the gates:
      // there is nothing to grade, and the existing failure path already explains why.
      // Overload exhaustion leaves `failureReason` as exactly 'overload' — the
      // string `executeWave`'s drain check compares on equality.
      if (!result.success || !baseline) {
        return overloadRetries > 0 ? { ...result, overloadCount: overloadRetries } : result
      }

      // R1.2: peers may have dispatched/finished since the last gate run — the
      // exemption set is refreshed at gate time, not captured at dispatch time.
      this.refreshExemptFiles(gateCtx, params.peers)
      this.applyWriteAttribution(gateCtx, writeActivity)
      const report = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)
      if (report.overall !== 'fail') {
        // M5 — advisory peer-review pass over the just-passed task. Findings
        // become ONE fix attempt appended to this ladder (never a new wave,
        // never a loop); survivors go to the unverified ledger. A pass failure
        // is ledgered inside the service and never blocks the task.
        const peerReviewed = await this.runPeerReviewIfEnabled({
          ...ladderParams,
          baselineCommit: baseline.baselineCommit,
          // The peer-review fix attempt is a model with write access. Without
          // the real capture its re-grade sees `testsBefore: {}` and
          // `test-integrity` goes `unverifiable` — leaving it the only ungated
          // writer in the pipeline.
          testsBefore: baseline.testsBefore,
          exemptFiles: gateCtx.exemptFiles
        })
        // P3b — `gradeTask` persists on EVERY grading, latest-wins, and the
        // peer-review re-grade is a grading too — against a synthetic baseline
        // that makes most gates unverifiable. Left alone, a task whose real
        // attempt PASSED ends the run with a failing report on its row, which
        // is why four tasks in one run read `write-set:fail` while their status
        // was `complete`. Re-assert the winning report. No ledger items are
        // passed: each grading already appended its own, and they accumulate.
        if (peerReviewed) blueprintTaskRepository.setGateReport(task.id, report)
        return {
          ...result,
          gateReport: report,
          ...(overloadRetries > 0 ? { overloadCount: overloadRetries } : {}),
          ...(peerReviewed ? { peerReviewed } : {})
        }
      }

      // The gates grade the WORKING TREE against a baseline captured once,
      // before attempt 1, and nothing else in this ladder reverts the tree — a
      // failed attempt's edits stay on disk (`commitTaskWork` runs on success
      // only). So an attempt that weakened a packet test file poisons every
      // attempt after it: the next one is graded on damage it did not do,
      // fails identically, trips the B3 stop-loss below, and hands the lead
      // model the same unfixable state. Restoring here — before the
      // fingerprint, and before the `break` into escalation — is what makes an
      // identical fingerprint mean what B3 assumes it means.
      const restoredTestFiles = this.restorePacketTests(
        gateCtx,
        baseline,
        failedTestIntegrityFiles(report),
        { blueprintId, workspaceId, taskId: task.taskId },
        { stage: 'ladder', attempt }
      )

      gateFixInstructions = buildGateFixInstructions(report, { restoredTestFiles })
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
      repeatCount = fingerprint !== '' && fingerprint === lastFingerprint ? repeatCount + 1 : 1
      lastFingerprint = fingerprint

      // The claim is about the RUN LENGTH, not the loop index: attempts 2 and 3
      // being identical is a run of 2, not 3. And a "stop-loss" on the last
      // attempt saves nothing — there is no rung left to skip — so it must not
      // announce one.
      const attemptsLeft = MAX_BUILDER_ATTEMPTS - attempt
      const stalled = repeatCount >= 2 && attemptsLeft > 0

      // The fingerprint normaliser handles ids/numbers/paths but not SHAs, ANSI
      // codes or hostnames, and gate evidence is command-output tails — so
      // whether this stop-loss is too coarse or too sensitive is an empirical
      // question. One bounded line per gate failure makes it answerable from a
      // real run instead of a guess.
      bpLog.info(
        `[gates] Task ${task.taskId} attempt ${attempt} gate fingerprint ` +
          `(repeat ${repeatCount}): ${fingerprint.slice(0, 120)}`
      )

      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Task ${task.taskId} failed quality gate(s): ${failedNames} — ` +
          (stalled
            ? `identical failure ${repeatCount}× in a row, skipping the remaining ` +
              `${attemptsLeft} builder attempt(s) — escalating to the lead-review model`
            : attempt < MAX_BUILDER_ATTEMPTS
              ? `retrying (attempt ${attempt + 1}/${MAX_BUILDER_ATTEMPTS})`
              : 'escalating to the lead-review model'),
        kind: 'system'
      })

      lastResult = {
        ...result,
        success: false,
        failureReason: `quality gate failed: ${failedNames}`,
        failureClass: 'quality',
        gateReport: report
      }

      // R1 — the gate-failed attempt, recorded after the decision is dispatched
      // (E11 convention: better-sqlite3 writes are synchronous). This is the row
      // the settle-time one could never produce: an attempt that fails its gates
      // and is then fixed by a retry disappears from the task table entirely.
      this.recordAttemptFailure({
        blueprintId,
        taskId: task.taskId,
        attempt,
        waveNum: params.waveNum,
        failureClass: 'quality',
        reason: `quality gate failed: ${failedNames}`,
        extra: { failedGates: failedNames, fingerprint: fingerprint.slice(0, 200), repeatCount }
      })

      if (stalled) {
        // Carried on the TaskResult, not written to the row here: every settled
        // task passes through handleTaskCompletion, which overwrites
        // `failure_reason` unconditionally (null on a recovered task, the final
        // reason otherwise) — so a write at this point is dead on arrival. When
        // escalation SUCCEEDS the note is dropped by design: the run recovered,
        // `attempts = 2` already encodes the saving, and the operator trail is
        // the warn below plus the phaseProgress line above.
        stopLossNote =
          `stop-loss after ${repeatCount} identical gate failure(s) ` +
          `(${failedNames}) — skipped ${attemptsLeft} builder ` +
          `attempt(s), escalated to blueprint:lead-review`
        bpLog.warn(
          `[gates] Task ${task.taskId} stop-loss: gate failure fingerprint unchanged ` +
            `across ${repeatCount} attempts — skipping ${attemptsLeft} ` +
            `builder attempt(s) and escalating`
        )
        // E11 — whether this stop-loss is too coarse or too sensitive is an
        // empirical question the log line alone cannot answer after the fact.
        // The fingerprint is capped for the same reason it is capped in the log.
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'stop_loss',
          phase: 'build',
          taskId: task.taskId,
          attempt,
          data: {
            repeatCount,
            attemptsSkipped: attemptsLeft,
            failedGates: failedNames,
            fingerprint: fingerprint.slice(0, 200)
          }
        })
        break
      }
    }

    // Builder retries exhausted — one attempt by the strong model, then hard hold.
    const escalated = await this.escalateToLead({
      ...ladderParams,
      gateCtx,
      baseline,
      gateFixInstructions,
      lastResult
    })
    // `escalateToLead` builds its own result and never returns `lastResult`, so
    // the note has to be appended here or it is lost. Kept after the existing
    // reason so `humanizeFailureReason`'s /quality gate failed/i branch still
    // matches instead of falling through to "surface verbatim".
    const withOverload =
      overloadRetries > 0 ? { ...escalated, overloadCount: overloadRetries } : escalated
    return stopLossNote !== '' && !withOverload.success
      ? {
          ...withOverload,
          failureReason: `${withOverload.failureReason ?? 'task failed'} — ${stopLossNote}`
        }
      : withOverload
  }

  /**
   * A1 (Steps 2+3+5) — evaluate the resume permit for one rung and record the
   * `session_resume` telemetry row either way.
   *
   * Called before every builder rung (attempt 1 declines with
   * `no-persisted-id`, which is correct — there is nothing to resume yet) and
   * before each in-ladder re-run. Returns the decision; the CALLER owns the
   * generation rotation, because only it knows whether the denial was on the
   * evidence of a failed outcome (rotate → fresh conversation) or a
   * precondition failure (keep → the id is still valid for a later rung).
   *
   * E12's lesson, applied directly: `attempted` / `succeeded` / `declined` are
   * three DISTINCT rows, so "resume attempted" and "resume actually happened"
   * can never be conflated in analysis.
   */
  private async decideResume(params: {
    blueprintId: string
    taskId: string
    attempt: number
    /** Conversation id of the CURRENT generation — where the persisted id lives. */
    convId: string
    generation: number
    outcome: Exclude<SendOutcome, 'ok'> | undefined
    resumeSafe: boolean | undefined
    providerAtStart: import('../../shared/types').LLMProvider
    workspacePath: string
    /** True when the rung whose failure produced `outcome` was itself a resume. */
    previousRungWasResume?: boolean
    /** A1 (Phase 0/P4) — DB-derived attempt of the rung this decision is about. */
    executeAttempt?: number
    /**
     * A1 (Phase 0) — the resume substrate from the PREVIOUS rung's TaskResult:
     * the live session id captured in that rung's finally, before teardown.
     * When present it is authoritative; a DB read would race the fire-and-forget
     * stop() that clears the id (poison rule) — the nondeterminism this phase
     * removes. Falls back to the DB read ONLY on the cross-restart branch
     * (Phase 4), where no in-ladder evidence exists by construction.
     */
    previousResumableSessionId?: string
    /** A1 (Phase 1) — the previous rung's session ended poisoned. */
    previousSessionPoisoned?: boolean
    /**
     * A1 (Phase 4) — permit attempt-1 cross-restart resume when no in-ladder
     * evidence exists. Requires the `blueprintCrossRunResume` sub-flag (default
     * OFF) AND the provider snapshot matching; the persisted id surviving at all
     * is itself evidence the last turn ended cleanly (poison clears the id).
     */
    allowCrossRun?: boolean
    /**
     * GLM-PROTOCOL-MISS-04: consecutive prior rungs that failed with the same
     * protocol-miss signature AND added zero write activity. ≥1 means the
     * transcript is poisoned for this task — every resume re-reads the same
     * drift-inducing history and fails identically. The next rung must start a
     * fresh session (identity rotation), not resume.
     */
    consecutiveProtocolMisses?: number
  }): Promise<ResumeDecision> {
    // The live conversation id of THIS generation — after a rotation the
    // persisted id lives on the `-gN` row, not the base one.
    const convId = params.generation > 0 ? `${params.convId}-g${params.generation}` : params.convId
    const flagOn = appPreferenceRepository.getAppPreferences().blueprintSessionResume
    const readPersistedId = (): string | undefined => {
      try {
        return conversationRepository.getSessionId(convId)
      } catch {
        /* cold, as today */
        return undefined
      }
    }
    let persistedSessionId: string | undefined
    // A1 (Phase 4) — attempt-1 / post-restart: no in-ladder evidence exists, so
    // the DB is the only source. Gated on its own default-OFF flag: this is the
    // one path that re-opens the orphaned-background-shell hazard the
    // `resolveSession` cross-restart guard exists for, and it needs its own
    // measured window before it becomes default.
    if (params.allowCrossRun && params.outcome === undefined) {
      const crossFlagOn =
        appPreferenceRepository.getAppPreferences().blueprintCrossRunResume === true
      const providerUnchanged =
        modelConfigService.getProvider(params.workspacePath) === params.providerAtStart
      if (crossFlagOn && providerUnchanged) {
        persistedSessionId = readPersistedId()
        if (persistedSessionId) {
          const decision: ResumeDecision = {
            resume: true,
            sessionId: persistedSessionId,
            crossRun: true
          }
          // E12 fire-time honesty — same as the in-ladder grant below.
          this.recordResumeTelemetry(params, 'attempted', {
            sessionId: persistedSessionId,
            generation: params.generation,
            crossRun: true
          })
          return decision
        }
      }
      // No persisted id, or the sub-flag is off: cold, as today.
      return { resume: false, reason: 'no-persisted-id' }
    }
    // A1 (Phase 0) — with in-ladder evidence, the previous rung's stamp is the
    // ONLY source. A DB read here would race the fire-and-forget teardown
    // (stop() → poison rule → id cleared) — the exact nondeterminism between
    // "never resumes" and "resumes a poisoned session" this phase removes.
    // `undefined` is meaningful: the session map already dropped the id.
    persistedSessionId = params.previousResumableSessionId
    const providerUnchanged =
      modelConfigService.getProvider(params.workspacePath) === params.providerAtStart

    // Stale-resume detection: the previous rung RESUMED and still failed — the
    // persisted id points at a session the backend will not re-attach to (dead
    // CLI transcript, restarted OpenCode server). Do not try it a second time;
    // fall back to cold on the same retry the ladder was already spending.
    //
    // A1-P2 — the OLD guard required `outcome !== undefined`, which only the
    // send-outcome path sets. Every throw-path failure (stall watchdog,
    // TASK_TIMEOUT_MS, transport) built its result in executeTask's catch with
    // `resumeSafe: true` and NO sendOutcome, so a resumed rung that failed that
    // way skipped stale detection entirely and was granted a second resume of
    // the same dead session. The evidence of a failed rung is now carried on
    // the TaskResult itself (Phase 0): outcome OR poisoned OR a dropped id all
    // count as "the rung failed at the session level".
    //
    // `overload` is exempt: a resumed turn rejected by rate limiting leaves the
    // session transcript intact — resuming again after the backoff is precisely
    // what the backoff exists for, and the cache read makes it cheap.
    const rungFailedAtSessionLevel =
      params.outcome !== undefined ||
      params.previousSessionPoisoned === true ||
      params.previousResumableSessionId === undefined
    if (
      params.previousRungWasResume === true &&
      params.outcome !== 'overload' &&
      rungFailedAtSessionLevel
    ) {
      const decision = resumeFallbackDecision()
      this.recordResumeTelemetry(params, 'declined', {
        reason: decision.reason,
        failureClass: 'infra',
        sessionId: persistedSessionId
      })
      return decision
    }

    // GLM-PROTOCOL-MISS-04 — poisoned-transcript escape. Repeated identical
    // protocol-miss failures with ZERO new write activity mean the resumed
    // transcript itself is the problem: the model re-reads its own prior
    // fence-less turn and repeats the mistake. Deny the resume (and rotate
    // identity via shouldRotateIdentity) so the retry starts a genuinely fresh
    // session with the fence reminder at maximum recency.
    if ((params.consecutiveProtocolMisses ?? 0) > 0) {
      const decision: ResumeDecision = { resume: false, reason: 'poisoned-transcript' }
      this.recordResumeTelemetry(params, 'declined', {
        reason: decision.reason,
        failureClass: 'infra',
        sessionId: persistedSessionId,
        consecutiveProtocolMisses: params.consecutiveProtocolMisses
      })
      return decision
    }

    const decision = evaluateResumePermit({
      outcome: params.outcome,
      resumeSafe: params.resumeSafe,
      flagOn,
      persistedSessionId,
      providerUnchanged,
      sessionPoisoned: params.previousSessionPoisoned
    })

    if (decision.resume) {
      // E12 fire-time honesty: `attempted` fires when the retry dispatches with
      // the resume; `succeeded` fires when that rung's executeTask returns. The
      // gap between the two is where silent resume failures live.
      this.recordResumeTelemetry(params, 'attempted', {
        failureClass: 'infra',
        sessionId: decision.sessionId,
        generation: params.generation
      })
    } else if (params.outcome !== undefined || params.previousRungWasResume === true) {
      // A decline is only news when a real failure prompted the decision:
      // attempt 1 always declines (nothing to resume yet) and would otherwise
      // flood the table with one no-op row per task per run.
      this.recordResumeTelemetry(params, 'declined', {
        reason: decision.reason,
        failureClass: params.outcome !== undefined ? 'infra' : undefined,
        sessionId: persistedSessionId
      })
    }
    return decision
  }

  /** A1 (Step 5) — one `session_resume` telemetry row. No CHECK on `kind` by design. */
  private recordResumeTelemetry(
    params: {
      blueprintId: string
      taskId: string
      attempt: number
      /** A1 (Phase 0) — the DB-derived attempt of the rung being decided about. */
      executeAttempt?: number
    },
    status: 'attempted' | 'succeeded' | 'declined' | 'failed-silently',
    data: {
      reason?: ResumeDeclineReason
      failureClass?: TaskFailureClass
      sessionId?: string
      generation?: number
      /** A1 (Phase 4) — the grant came from the cross-restart branch. */
      crossRun?: boolean
      /** A1 (Phase 3) — sub-reason of a failed-silently downgrade. */
      silentReason?: string
      /** A1 (Phase 3) — cache-read tokens of the rung, for Gate 1. */
      cacheReadInputTokens?: number
      /** GLM-PROTOCOL-MISS-04 — consecutive zero-write protocol-miss rungs. */
      consecutiveProtocolMisses?: number
    }
  ): void {
    try {
      blueprintTelemetryRepository.record({
        blueprintId: params.blueprintId,
        kind: 'session_resume',
        phase: 'build',
        taskId: params.taskId,
        attempt: params.attempt,
        data: {
          status,
          ...data,
          // A1-P4 — the DB-derived attempt of the rung the decision is about,
          // when known. The ladder's loop counter never advances on
          // overload/infra re-runs, so this is what joins against
          // turn_usage.attempt.
          ...(params.executeAttempt !== undefined ? { executeAttempt: params.executeAttempt } : {})
        }
      })
    } catch (err) {
      bpLog.warn('[A1:resume-telemetry] failed to record session_resume row:', err)
    }
  }

  /**
   * Undo an attempt's edits to the packet's pre-authored test files.
   *
   * Bounded by the list the caller passes, which `restorePacketTestFiles`
   * bounds again to files the baseline actually captured (so, declared in the
   * packet), resolving inside the execution path, and NOT declared by a peer
   * task. A file the builder legitimately EXTENDED passes the gate and is never
   * in a report-driven list; the sweep skips it explicitly.
   *
   * Never fatal: a tree we could not repair is exactly the tree we had.
   */
  private restorePacketTests(
    gateCtx: GateTaskContext,
    baseline: GateBaseline,
    offending: readonly string[],
    ids: { blueprintId: string; workspaceId: string; taskId: string },
    origin: { stage: 'ladder' | 'escalation' | 'sweep' | 'peer-review'; attempt?: number }
  ): string[] {
    if (offending.length === 0) return []

    let restored: string[] = []
    try {
      restored = restorePacketTestFiles(gateCtx, baseline, offending)
    } catch (err) {
      bpLog.warn(`[gates] Packet test-file restore failed for ${ids.taskId}:`, err)
      return []
    }
    if (restored.length === 0) return []

    const listed = restored.slice(0, MAX_LISTED_PATHS).join(', ')
    const more =
      restored.length > MAX_LISTED_PATHS ? ` …and ${restored.length - MAX_LISTED_PATHS} more` : ''

    bpLog.info(
      `[gates] Task ${ids.taskId} — restored ${restored.length} packet test file(s) to the ` +
        `pre-session spec (${origin.stage}): ${listed}${more}`
    )
    this.safeEmit('phaseProgress', {
      blueprintId: ids.blueprintId,
      workspaceId: ids.workspaceId,
      phase: 'build',
      text:
        `↺ Task ${ids.taskId}: restored ${restored.length} packet test file(s) ` +
        `weakened by the failed attempt — ${listed}${more}`,
      kind: 'system'
    })
    // E11 — after the decision is taken and the message is out.
    blueprintTelemetryRepository.record({
      blueprintId: ids.blueprintId,
      kind: 'test_restore',
      phase: 'build',
      taskId: ids.taskId,
      ...(origin.attempt !== undefined ? { attempt: origin.attempt } : {}),
      data: {
        stage: origin.stage,
        fileCount: restored.length,
        offeredCount: offending.length,
        files: restored.slice(0, MAX_LISTED_PATHS)
      }
    })
    return restored
  }

  /**
   * The tree-driven net: whatever the ladder did or failed to do, a task that
   * did not succeed must not END with a weakened packet spec on disk.
   *
   * The report-driven restore above only fires where a `test-integrity` verdict
   * exists, and the ladder has exits that produce none — `runGates`
   * short-circuits before test-integrity when `write-set` or `stub-scan` fails,
   * and a session that fails outright or is aborted is never graded. Left
   * behind, that damage is laundered by the operator's next Retry: the fresh
   * baseline captures the weakened file as the spec and every gate goes green.
   * A false green is worse than the sticky red this feature replaced.
   */
  private sweepPacketTestDamage(
    gateCtx: GateTaskContext,
    baseline: GateBaseline,
    ids: { blueprintId: string; workspaceId: string; taskId: string }
  ): void {
    try {
      const diverged = divergedPacketTestFiles(gateCtx, baseline)
      this.restorePacketTests(gateCtx, baseline, diverged, ids, { stage: 'sweep' })
    } catch (err) {
      // Best effort by construction: this runs on the way out of a task that
      // already failed, and must never replace its failure with its own.
      bpLog.warn(`[gates] Packet test-file sweep failed for ${ids.taskId}:`, err)
    }
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
    /** The real pre-session packet test files, so the re-grade judges them too. */
    testsBefore?: GateBaseline['testsBefore']
    exemptFiles?: readonly string[]
    peers?: readonly BlueprintTask[]
    /** P0 — the task's cumulative write activity; the fix attempt adds to it. */
    writeActivity?: TaskWriteActivity
    baselineDiffEmpty?: () => Promise<boolean | null>
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
      artifactPrefix: params.phaseContext.blueprintDir,
      commandGates: ['build']
    }
    this.refreshExemptFiles(gateCtx, params.peers)
    this.applyWriteAttribution(gateCtx, params.writeActivity)
    const baseline: GateBaseline = {
      baselineCommit: params.baselineCommit,
      preexistingDirty: [],
      testsBefore: params.testsBefore ?? {},
      redProof: 'unavailable',
      redEvidence: []
    }
    const fixReport = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)

    // F2 — the re-grade's verdict is discarded by design: P3b re-asserts the
    // ORIGINAL passing report on the task row, because this grading runs against
    // a synthetic baseline that makes most gates unverifiable and would
    // otherwise mark a passing task failed. The cost was that the peer-review
    // fix — a model with write access — became the one writer in the pipeline
    // whose verdict landed nowhere: on blueprint 6c4a6a85 T012's stored report
    // is its PRE-peer-review one, and the 69-line deletion its fix attempt made
    // six minutes after the passing grade was invisible by construction.
    //
    // Telemetry is the right home for it: queryable after the run, and it cannot
    // overwrite the verdict the task legitimately earned.
    const regradeFailedGates = fixReport.gates
      .filter((g) => g.verdict === 'fail')
      .map((g) => g.name)
    blueprintTelemetryRepository.record({
      blueprintId,
      kind: 'peer_review_regrade',
      phase: 'build',
      taskId: task.taskId,
      data: {
        overall: fixReport.overall,
        failedGates: regradeFailedGates,
        findings: outcome.review.findings.length
      }
    })

    if (fixReport.overall === 'fail') {
      // Same reasoning as the telemetry row, in the operator-facing ledger: a
      // peer-review pass that breaks the tree must leave a visible mark, since
      // the task row will keep showing the report from the attempt that passed.
      blueprintRepository.appendUnverified(blueprintId, [
        {
          taskId: task.taskId,
          gate: 'peer-review',
          reason: 'pass_error',
          detail:
            `peer-review fix attempt left the tree failing ` +
            `${regradeFailedGates.join(', ')} — the task's stored gate report is ` +
            'from the attempt BEFORE peer review',
          at: new Date().toISOString()
        }
      ])

      // Same guarantee as every other rung: a fix attempt that weakened the
      // packet spec does not get to leave it weakened. This one never blocks
      // the task, so without the restore the damage would ship with a passing
      // report from the ORIGINAL attempt on the row.
      this.restorePacketTests(
        gateCtx,
        baseline,
        failedTestIntegrityFiles(fixReport),
        { blueprintId, workspaceId, taskId: task.taskId },
        { stage: 'peer-review' }
      )
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
    /** P1a: every task in the blueprint, for peer-file exemption. */
    peers?: readonly BlueprintTask[]
    /** P0 — the task's cumulative write activity; escalation adds to it. */
    writeActivity?: TaskWriteActivity
    baselineDiffEmpty?: () => Promise<boolean | null>
    /**
     * A1 (P7) — generation of this task's conversation identity. Carried here
     * at runtime by the `...ladderParams` spread but previously OMITTED from
     * this declared type, so nothing type-checked the path: a refactor to
     * explicit destructuring would silently drop it and escalation would write
     * its session id onto the abandoned generation-0 row.
     */
    taskGeneration?: number
  }): Promise<TaskResult> {
    const { task, blueprintId, workspaceId, gateCtx, baseline, lastResult } = params

    blueprintTaskRepository.setEscalatedTo(task.id, 'blueprint:lead-review')
    bpLog.warn(
      `[gates] Task ${task.taskId} exhausted ${MAX_BUILDER_ATTEMPTS} builder attempt(s) — escalating`
    )
    // E11 — recorded on ENTRY, not on the result. Escalation is the most
    // expensive rung in the ladder (a lead-tier model on a full cold session),
    // so "how often do we get here" is the question, and an escalation that
    // crashes mid-flight is exactly the one worth having a row for.
    blueprintTelemetryRepository.record({
      blueprintId,
      kind: 'escalation',
      phase: 'build',
      taskId: task.taskId,
      data: {
        to: 'blueprint:lead-review',
        builderAttempts: MAX_BUILDER_ATTEMPTS,
        lastFailureReason: lastResult?.failureReason ?? null
      }
    })

    const result = await this.executeTask({
      ...params,
      gateFixInstructions: params.gateFixInstructions,
      modelAction: 'blueprint:lead-review'
    })
    blueprintTaskRepository.recordAttempt(task.id)

    if (!result.success || !baseline) {
      return result.success ? result : (result ?? lastResult ?? result)
    }

    this.refreshExemptFiles(gateCtx, params.peers)
    this.applyWriteAttribution(gateCtx, params.writeActivity)
    const report = await this.gradeTask(gateCtx, baseline, task, blueprintId, workspaceId)
    if (report.overall !== 'fail') return { ...result, gateReport: report }

    // The lead model just failed its own grading, and this is where the most
    // common terminal path ENDS — so without this the run finishes with the
    // weakened spec on disk. The operator clicks Retry, `captureGateBaseline`
    // re-reads the weakened file, the violation becomes the new baseline and
    // every gate goes green: a false green, which is strictly worse than the
    // sticky red the ladder restore replaced.
    this.restorePacketTests(
      gateCtx,
      baseline,
      failedTestIntegrityFiles(report),
      { blueprintId, workspaceId, taskId: task.taskId },
      { stage: 'escalation' }
    )

    const failedNames = report.gates
      .filter((g) => g.verdict === 'fail')
      .map((g) => g.name)
      .join(', ')
    return {
      ...result,
      success: false,
      failureReason: `quality gate failed after escalation: ${failedNames}`,
      failureClass: 'quality',
      gateReport: report
    }
  }

  /**
   * Recompute `gateCtx.exemptFiles`: every OTHER task's declared files
   * (scheduler write-set ∪ packet allowedFiles), regardless of lifecycle state.
   *
   * P1a — this used to source from the IN-FLIGHT set only, which is wrong in
   * exactly the case that costs work. The baseline is captured once before
   * attempt 1 and reused for every retry, so a task retrying at 14:32 diffs
   * against a tree from 14:22. A peer that FINISHED in between is in neither
   * the baseline nor the in-flight map, so its committed deliverable lands
   * inside this task's diff and the write-set gate reports it as this task's
   * violation — which is how `.env.example` (T002, complete and verified) was
   * named in T001's gate report and then reverted by T001.
   *
   * A file another task declares is never this task's to write. That is true
   * before it starts, while it runs, and after it finishes.
   *
   * Exact-path semantics are preserved downstream (`collectChanges`): a peer
   * declaring `src/` must not exempt this task's `src/other.ts`. `forbiddenFiles`
   * still fails hard, so the gate does not go blind.
   *
   * F5 — `packet.testFiles` is unioned too. A peer's spec is as much its
   * property as its implementation, and the two declaration lists are not
   * interchangeable: a packet that names a spec ONLY in `testFiles` used to
   * leave it unexempted, so a peer's own edit to its own spec landed in this
   * task's diff and `test-integrity` failed this task for it. On blueprint
   * 6c4a6a85 the file happened to appear in `filePathsJson` as well, which is
   * the only reason the peer-exemption path engaged at all.
   */
  private refreshExemptFiles(
    gateCtx: GateTaskContext,
    peers: readonly BlueprintTask[] | undefined
  ): void {
    if (!peers) return
    const exempt = new Set<string>()
    for (const peer of peers) {
      if (peer.taskId === gateCtx.taskId) continue
      for (const f of normalizePaths(peer.filePathsJson)) exempt.add(f)
      for (const f of peer.packetJson?.allowedFiles ?? []) exempt.add(f)
      for (const f of peer.packetJson?.testFiles ?? []) exempt.add(f)
    }
    gateCtx.exemptFiles = [...exempt]
  }

  /**
   * F1 (step 2) — hand the gates the paths this task's own write tools targeted.
   *
   * Called beside `refreshExemptFiles` at every grading point, because the two
   * are opposite halves of one question: `exemptFiles` says which paths belong
   * to somebody else, and this says which of those this task nevertheless wrote.
   * Without it the gate cannot tell the two directions apart and must report
   * `unverifiable`.
   */
  private applyWriteAttribution(
    gateCtx: GateTaskContext,
    writeActivity: TaskWriteActivity | undefined
  ): void {
    if (!writeActivity) return
    gateCtx.writtenPaths = [...writeActivity.writtenPaths]
  }

  /**
   * F1d — turn a failing wave-gate report into a `taskFailures` entry so the
   * phase-failure summary (and the retry context / UI) says WHY, not just
   * "One or more build tasks failed". Gate name + verdict + the first few
   * evidence lines — the shell's "'pytest' is not recognized" line used to be
   * captured and never shown (incident 2026-08, ~20 blind retries).
   */
  private pushWaveGateFailure(result: BuildResult, waveLabel: string, report: GateReport): void {
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

    // P3b — wave/drain gate results wrote NO telemetry. On the run this came
    // from, the W4 failure that killed the build existed only inside the phase
    // artifact: `drainCount: 1` recorded that gates ran once and nothing
    // recorded what they found. The reporter prints any kind, so the row is the
    // whole fix.
    blueprintTelemetryRepository.record({
      blueprintId,
      kind: 'gate',
      phase: 'build',
      taskId: waveTaskId,
      data: {
        wave: waveNum,
        overall: report.overall,
        gates: report.gates.map((g) => ({
          name: g.name,
          verdict: g.verdict,
          ...(g.reason ? { reason: g.reason } : {}),
          durationMs: g.durationMs
        }))
      }
    })

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
   * A6 — enforce the per-task commit in the run's execution tree.
   *
   * Contract, not convenience: `scanTaskCommitSurvival` attributes commits to
   * tasks via `TASK_ID_IN_SUBJECT`, and both the per-attempt destructive-revert
   * gate and L3's `reconcileBuildOutput` lean on that attribution. Today the
   * commit is prompt-requested only (build-phase.md "Reference the task ID in
   * the commit message"), so the headline defence degrades to `dropped: null`
   * (unverifiable) on any run where the agent doesn't commit or omits the id.
   *
   * Rules:
   * • Isolation gate — only when the run has its own tree
   *   (`executionPath !== workspacePath`, the same fact `track.isolated`
   *   encodes). Never commit into the primary tree.
   * • Backstop, not replacement — if the agent already committed
   *   (`git status --porcelain` empty), skip.
   * • `git add -A` scoped to the execution root, matching the containment
   *   discipline used everywhere else in this file.
   * • Non-fatal — a failed commit logs + records telemetry and returns. A6
   *   must not be able to turn a green task red.
   */
  private async commitTaskWork(params: {
    task: BlueprintTask
    blueprintId: string
    executionPath: string
    workspacePath: string
    /** A6-fix: `completion.filesModified` from the settled result — the agent's own claim. */
    reportedFiles: string[]
  }): Promise<void> {
    const { task, blueprintId, executionPath, workspacePath } = params
    if (executionPath === workspacePath) {
      // No isolated run tree — the primary tree is shared with the user's own
      // uncommitted work; committing here is exactly what the isolation gate
      // exists to prevent.
      return
    }

    try {
      const git = simpleGit(executionPath)
      const status = await git.status()
      if (status.isClean()) {
        // Agent already committed (it is still asked to) — nothing to enforce.
        return
      }

      // A6-fix — NEVER `git add -A`. Under the concurrent scheduler up to `cap`
      // tasks are mid-flight in this one executionPath; add -A sweeps siblings'
      // in-flight writes into a commit bearing whichever task settled first,
      // and scanTaskCommitSurvival then attributes that code to the wrong task.
      // Commit exactly: (paths git reports dirty) ∩ (task's own claims).
      const claimed = new Set([
        ...normalizePaths(task.filePathsJson),
        ...normalizePaths(params.reportedFiles)
      ])
      const toAdd = status.files.map((f) => f.path).filter((p) => claimed.has(normalize(p)))

      if (toAdd.length === 0) {
        // Honest degradation to the pre-A6 state: leave the dirty tree alone
        // rather than mis-attribute a sibling's (or unknown) work to this task.
        bpLog.info(
          `[a6-task-commit] ${task.taskId} — ${status.files.length} dirty file(s) claimable ` +
            `by neither filePathsJson nor completion.filesModified — leaving uncommitted`
        )
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'task_commit',
          taskId: task.taskId,
          data: { mode: 'unattributable', dirtyCount: status.files.length }
        })
        return
      }

      const subject = buildTaskCommitSubject({
        taskId: task.taskId,
        description: task.description
      })

      await git.add(toAdd)
      // Pathspec on commit itself: even if another sibling dirtied the shared
      // index between add and commit, only this task's paths land in the commit.
      await git.commit(subject, toAdd)
      bpLog.info(
        `[a6-task-commit] ${task.taskId} — committed ${toAdd.length} claimed file(s) in ` +
          `${executionPath}: "${subject}"`
      )
      blueprintTelemetryRepository.record({
        blueprintId,
        kind: 'task_commit',
        taskId: task.taskId,
        data: { subject, mode: 'enforced', fileCount: toAdd.length }
      })
    } catch (err) {
      // Deliberately non-fatal: log + telemetry, never rethrow. A green task
      // stays green even when git cannot be reached.
      const message = err instanceof Error ? err.message : String(err)
      bpLog.warn(`[a6-task-commit] ${task.taskId} — commit failed (non-fatal): ${message}`)
      blueprintTelemetryRepository.record({
        blueprintId,
        kind: 'task_commit',
        taskId: task.taskId,
        data: { mode: 'failed', error: message.slice(0, 300) }
      })
    }
  }

  /**
   * Process a completed task: update DB, accumulate results, emit events.
   */
  /**
   * R1/M0 — one append-only row per FAILED ATTEMPT of a build task.
   *
   * The retry-cause split (infra vs. quality) is what decides whether a
   * durable-session retry path is worth building, and it is not derivable after
   * the fact: `failure_reason` is prose, and a task that eventually SUCCEEDS has
   * its reason cleared — erasing every retry that led there. A settle-time row
   * cannot fix that either, because settle happens once per task; only a row
   * written from inside the ladder, carrying the attempt index, can.
   *
   * Never throws (the repository swallows its own failures): telemetry observes
   * the build, it never participates in it.
   */
  private recordAttemptFailure(params: {
    blueprintId: string
    taskId: string
    attempt: number
    waveNum: number
    failureClass: TaskFailureClass | undefined
    reason: string
    extra?: Record<string, unknown>
  }): void {
    blueprintTelemetryRepository.record({
      blueprintId: params.blueprintId,
      kind: 'task_failure',
      phase: 'build',
      taskId: params.taskId,
      attempt: params.attempt,
      data: {
        failureClass: params.failureClass ?? 'unknown',
        reason: params.reason.slice(0, 200),
        wave: params.waveNum,
        ...(params.extra ?? {})
      }
    })
  }

  private async handleTaskCompletion(params: {
    task: BlueprintTask
    taskResult: TaskResult
    blueprintId: string
    workspaceId: string
    waveNum: number
    result: BuildResult
    /** A6: where the agents wrote (run worktree or primary tree). */
    executionPath: string
    /** A6: the primary tree — commits are enforced only in an isolated run tree. */
    workspacePath: string
    /** A6-fix: `completion.filesModified` — the settled task's own file claims. */
    reportedFiles: string[]
  }): Promise<void> {
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

      // A6 — enforce the per-task commit. The prompt still ASKS the agent to
      // commit (build-phase.md) and this is the backstop, not the replacement:
      // when the agent already committed, the dirty check below no-ops. With the
      // commit guaranteed, scanTaskCommitSurvival's "none naming a task id"
      // branch fires only on genuinely broken workspaces instead of every
      // non-committing run, and L3's reconcileBuildOutput gets real signal
      // instead of `scanUnavailable`. Failure here is deliberately non-fatal —
      // a commit problem must never turn a green task red.
      await this.commitTaskWork({
        task,
        blueprintId,
        executionPath: params.executionPath,
        workspacePath: params.workspacePath,
        reportedFiles: params.reportedFiles
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
      // R1 — no `task_failure` row here. It used to be written at settle, which
      // meant one row per TASK and none at all for a task that retried and then
      // succeeded. The rows now come from inside `executeTaskWithGates`, one per
      // failed ATTEMPT; writing another here would double-count the last one.
      // The terminal reason for a task that stays failed is on
      // `blueprint_tasks.failure_reason`, set immediately above.
    }

    this.safeEmit('waveTaskComplete', {
      blueprintId,
      workspaceId,
      wave: waveNum,
      taskId: task.taskId,
      status: taskResult.success ? 'complete' : 'failed'
    } satisfies BlueprintWaveTaskCompletePayload)
  }

  /**
   * P3a — at BUILD end, does the tree still contain what the completed tasks
   * claimed?
   *
   * On the run this was written for, the DB recorded 15/15 complete and
   * verified while THREE finished deliverables had been reverted out of the
   * tree by later tasks — an `.env.example` block, nodemailer version pins, and
   * an 89-line notification template whose missing export failed the W4
   * typecheck 31 minutes later. Every one of them was CLAIMED in a
   * `completion_json` belonging to a task marked verified.
   *
   * Two questions, one pass:
   *   1. does every claimed path still exist?
   *   2. do the commits that claimed them still contribute to HEAD?
   *
   * (2) is what catches a file that survives with its contents removed, which
   * is what actually happened all three times. A finding fails the phase with a
   * reason that names the victim, rather than letting the run be graded by a
   * generic gate failure thirty minutes downstream — and resets those victims to
   * `pending`, so the retry rebuilds them instead of re-reporting the same
   * failure forever (see the reset block below for why that is not optional).
   */
  private async reconcileBuildOutput(params: {
    blueprintId: string
    workspaceId: string
    executionPath: string
    allTasks: readonly BlueprintTask[]
    result: BuildResult
  }): Promise<void> {
    const { blueprintId, workspaceId, executionPath, allTasks, result } = params
    const started = Date.now()

    // 1. Claimed paths that are gone.
    const missing: { taskId: string; file: string }[] = []
    /**
     * taskId → the paths it claimed to have MODIFIED. Only these are subject to
     * the line-survival check below.
     *
     * The two claim kinds assert different things, and conflating them produces
     * false failures. `filesCreated` claims "this file exists" — the existence
     * check above is the whole of it. `filesModified` claims "my changes are in
     * it", which only a line-level check can confirm. Live example: T009 created
     * a byte-identical mailer twin; repairing the ORIGINAL that T005 had gutted
     * legitimately rewrote a few stale lines in T009's copy, and billing that as
     * "T009's work was destroyed" would block the build on a correct fix. T008,
     * by contrast, claimed the gutted file as MODIFIED — 52 of its lines really
     * were gone, and that is the failure worth stopping for.
     */
    const modifiedByTask = new Map<string, Set<string>>()
    let tasksChecked = 0
    let claimedFiles = 0
    for (const task of allTasks) {
      const row = blueprintTaskRepository.findById(task.id)
      if (!row || row.status !== 'complete' || row.skippedByUserAt) continue
      tasksChecked++
      const createdPaths = asStringArray(row.completionJson?.filesCreated)
      const modifiedPaths = asStringArray(row.completionJson?.filesModified)
      const claimed = new Set([...createdPaths, ...modifiedPaths])
      modifiedByTask.set(row.taskId, new Set(modifiedPaths.map((f) => normalizePath(f))))
      for (const rel of claimed) {
        claimedFiles++
        // A path that escapes the execution root is not a claim we can check.
        const abs = isAbsolute(rel) ? rel : resolve(executionPath, rel)
        const inside = relative(executionPath, abs)
        if (inside.startsWith('..') || isAbsolute(inside)) continue
        if (!existsSync(abs)) missing.push({ taskId: row.taskId, file: normalizePath(rel) })
      }
    }

    // 2. Committed work that no longer survives in the tree. Same scan the
    //    per-attempt `destructive-revert` gate uses, with no task excluded:
    //    here the question is about the whole build, not one attempt.
    const settings = (blueprintRepository.findById(blueprintId)?.settingsJson ?? {}) as Record<
      string,
      unknown
    >
    const baselineCommit =
      typeof settings.buildBaselineCommit === 'string' ? settings.buildBaselineCommit : null
    const scan = await scanTaskCommitSurvival({
      cwd: executionPath,
      baselineCommit,
      runner: defaultCommandRunner
    })

    // Narrowed to files the victim task claimed to have MODIFIED. A commit also
    // touches lockfiles and incidental paths, and a later task rewriting one of
    // those is ordinary work, not lost output. The claim is what makes a finding
    // meaningful — every deliverable destroyed on the run this was built for was
    // claimed by a task marked complete and verified.
    const victims = new Map<string, Set<string>>()
    for (const d of scan.dropped ?? []) {
      if (!modifiedByTask.get(d.taskId)?.has(d.file)) continue
      const files = victims.get(d.taskId) ?? new Set<string>()
      files.add(d.file)
      victims.set(d.taskId, files)
    }

    blueprintTelemetryRepository.record({
      blueprintId,
      kind: 'reconciliation',
      phase: 'build',
      data: {
        tasksChecked,
        claimedFiles,
        missingFiles: missing.length,
        missingExamples: missing.slice(0, 10).map((m) => `${m.taskId}:${m.file}`),
        droppedLines: scan.dropped?.length ?? 0,
        victimTasks: [...victims.keys()],
        commitsScanned: scan.commitsScanned,
        ...(scan.dropped === null ? { scanUnavailable: scan.reason ?? 'unknown' } : {}),
        durationMs: Date.now() - started
      }
    })

    if (missing.length === 0 && victims.size === 0) {
      bpLog.info(
        `[reconcile] ${tasksChecked} completed task(s), ${claimedFiles} claimed file(s) — ` +
          `tree matches the record` +
          (scan.dropped === null ? ` (commit survival unverifiable: ${scan.reason})` : '')
      )
      return
    }

    // The two findings carry different certainty, so they get different powers.
    //
    // A claimed path that does not exist is a FACT: the task said it wrote the
    // file, the file is not there. That blocks.
    //
    // Line survival is a HEURISTIC, and three false positives on two runs
    // showed it is not precise enough to gate a pipeline on: R003 refining
    // T011's sign-off notification, and a hand-repair of T008's mailer, both
    // read as “work destroyed” because a later task legitimately changed lines
    // an earlier one wrote. The net-negative and task-attribution rules in
    // `scanTaskCommitSurvival` narrow it a lot, but “revised” and “reverted” are
    // not reliably separable from a diff alone. It still found every genuine
    // loss, so it keeps reporting — loudly, and in queryable telemetry — without
    // the power to stop a build that is otherwise green.
    const missingParts = missing
      .slice(0, 10)
      .map((m) => `${m.taskId} claimed ${m.file}, which no longer exists`)
    const victimParts = [...victims].map(
      ([taskId, files]) =>
        `${taskId}'s committed work in ${[...files].slice(0, 5).join(', ')} was removed by a later task`
    )

    if (victimParts.length > 0) {
      bpLog.warn(`[reconcile] Possible lost work (not blocking) — ${victimParts.join('; ')}`)
      this.safeEmit('phaseProgress', {
        blueprintId,
        workspaceId,
        phase: 'build',
        text:
          `⚠ Reconciliation: ${victimParts.slice(0, 3).join('; ')} — recorded, not blocking. ` +
          `Check the diff if this feature looks incomplete.`,
        kind: 'system'
      })
    }

    if (missingParts.length === 0) return

    const reason = `build record does not match the tree — ${missingParts.join('; ')}`
    bpLog.error(`[reconcile] ${reason}`)

    // Reset the victims so a RETRY repairs this instead of re-reporting it.
    //
    // Without it the failure is a dead end: every task is `complete`, so the
    // resume pre-pass settles all of them, nothing dispatches, reconciliation
    // fails again in about a second, and no amount of retrying can restore the
    // work. A task whose claimed output is not in the tree has not, in any
    // useful sense, completed — so put it back to `pending` and let the next
    // retry rebuild exactly the deliverables that went missing.
    //
    // `resetForRetry` clears the stale gate report and escalation flag with it,
    // matching `retryPhase`'s reset (`blueprint.service.ts:1502`). `attempts`
    // stays monotonic on purpose. Complementary to that path rather than a
    // duplicate of it: `retryPhase` deliberately leaves `complete` tasks alone,
    // and `complete` is exactly the state this failure is about.
    const toReset = new Set<string>(missing.map((m) => m.taskId))
    const resetIds: string[] = []
    for (const task of allTasks) {
      if (!toReset.has(task.taskId)) continue
      // BP-TASK-USER-SKIP-01: a human decided this task's fate. Read fresh —
      // the decision may post-date `allTasks`.
      const fresh = blueprintTaskRepository.findById(task.id)
      if (!fresh || fresh.skippedByUserAt) continue
      blueprintTaskRepository.updateStatus(task.id, 'pending')
      blueprintTaskRepository.resetForRetry(task.id)
      resetIds.push(task.taskId)
    }
    if (resetIds.length > 0) {
      bpLog.warn(`[reconcile] Reset ${resetIds.join(', ')} to pending — a retry will rebuild them`)
      blueprintTelemetryRepository.record({
        blueprintId,
        kind: 'reconciliation',
        phase: 'build',
        data: { action: 'reset_victims', tasks: resetIds }
      })
    }

    result.failed = true
    result.taskFailures.push({ taskId: 'reconciliation', reason })
    this.safeEmit('phaseProgress', {
      blueprintId,
      workspaceId,
      phase: 'build',
      text:
        `⚠ Reconciliation failed — ${missingParts.slice(0, 3).join('; ')}` +
        (resetIds.length > 0
          ? ` — reset ${resetIds.join(', ')} to pending; retry to rebuild them`
          : ''),
      kind: 'system'
    })
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

    // Guard: don't overwrite 'cancelled' status
    const currentStatus = blueprintRepository.findById(blueprintId)?.status
    if (currentStatus !== 'cancelled') {
      blueprintRepository.updateStatus(blueprintId, 'failed')
    }

    // M5: Use failPipeline to properly transition machine to 'failed' state.
    // F3 — a FALSY check, not `??`: an empty-string error slipped past the
    // nullish fallback and was then matched against the retry patterns, where it
    // matches nothing at all. The failure then reads as a bare "" everywhere it
    // is surfaced.
    const errorMsg = error || 'Build phase failed'

    // F6 — the reason, on the row. Written with the status (after `errorMsg` is
    // resolved, so the row never carries the bare empty string the falsy check
    // above exists to catch) because a failed phase whose reason is only in a
    // fired-and-forgotten IPC event cannot be diagnosed after a reload.
    if (buildPhaseId) {
      blueprintPhaseRepository.updateStatus(buildPhaseId, 'failed', errorMsg)
    }

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

    // PREMORTEM-#5 — unproven-rate visibility. Tasks that closed `unproven`
    // (freshness not provable / completion block missing but work present)
    // still count as completed, so the rate was invisible everywhere. One log
    // line + one telemetry row per BUILD completion with ≥1 unproven task —
    // the watch metric, no new UI.
    try {
      const settledTasks = blueprintTaskRepository.findByBlueprint(blueprintId)
      const unprovenCount = settledTasks.filter((t) => t.outcomeKind === 'unproven').length
      if (unprovenCount > 0) {
        bpLog.warn(
          `[finalizeSuccess] Blueprint ${blueprintId} — ${unprovenCount}/${settledTasks.length} ` +
            `task(s) closed unproven (completion block missing or freshness not provable)`
        )
        blueprintTelemetryRepository.record({
          blueprintId,
          kind: 'unproven_outcomes',
          phase: 'build',
          data: { count: unprovenCount, total: settledTasks.length }
        })
      }
    } catch (err) {
      bpLog.warn('[finalizeSuccess] unproven-outcome count failed (non-fatal):', err)
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
    /**
     * P0 — write activity accumulated across every attempt of this task. Absent
     * only for callers outside the gate ladder, where a task-scoped view does
     * not exist and the per-attempt counters are the whole truth.
     */
    writeActivity?: TaskWriteActivity
    /** P0 — "did this task change anything since its baseline"; null = unknown. */
    baselineDiffEmpty?: () => Promise<boolean | null>
    /**
     * A1 — generation of this task's conversation identity. 0 on the first
     * attempt; incremented by the ladder only when the resume permit is DENIED
     * (context overflow, turn-limit exhaustion, provider change). A stable id
     * plus a generation is what makes "resume vs cold" a decision instead of an
     * accident of `Date.now()` naming.
     */
    taskGeneration?: number
    /**
     * A1 — resume this persisted CLI/OpenCode session id instead of starting
     * cold. Only set when `evaluateResumePermit` said yes (flag on + resume-safe
     * outcome + id present + provider unchanged).
     */
    resumeSessionId?: string
    /**
     * A1 — the conversation id whose row holds the session id being resumed.
     * Seeding `AgentSessionService`'s session map needs the explicit key — its
     * `_lastActiveConversationId` is null until the first send(), and build
     * supplies the conversation id at send time, after start().
     */
    resumeConversationId?: string
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

    // Re-read the row, do not trust `task`. The BlueprintTask handed to this
    // method is the snapshot taken when the wave dispatched; `gradeTask` writes
    // the gate report to the DB, not to that object, so `task.gatesJson` is the
    // state BEFORE attempt 1 on every attempt. The previous attempt's verdict
    // exists only on the row.
    const currentRow = blueprintTaskRepository.findById(task.id)

    // Attribution for this session's usage rows. `recordAttempt` bumps the
    // counter AFTER executeTask returns, so the stored value is the number of
    // prior attempts and this run is the next one.
    const attempt = (currentRow?.attempts ?? 0) + 1

    // A1 (Steps 2–3) — opt-in resume. `resumeSessionId` is set only by the
    // ladder, only after `evaluateResumePermit` approved it, which is the
    // structural difference from the accidental DB-load path the cross-restart
    // guard in `resolveSession` exists to reject. The guard stays untouched for
    // every other caller: here the session map is pre-seeded explicitly, so the
    // id resolves `fromMemory === true` and never reaches the guard at all.
    const resuming = Boolean(params.resumeSessionId && params.resumeConversationId)

    // A1 (Phase 2, G7) — a RESUMED retry sends a short continuation message, not
    // the full cold context. The session's transcript already holds the task
    // statement, spec/plan artifacts, the agent's prior work, the failure
    // memory and the 4K partial — re-sending any of those duplicates the
    // transcript tail and makes the −50% context target unreachable. The only
    // thing the session does NOT have is the verdict of the failure that
    // triggered this retry, so that is all this message carries.
    //
    // Note: failure memory (P2) is deliberately suppressed here — it belongs on
    // COLD gate-failure retries, where the fresh session has never seen the
    // failed attempt's output. On a resumed retry the same content is already
    // in the transcript.
    let taskContext: string
    let failureMemoryExtraction: string | null = null
    if (resuming) {
      taskContext = buildResumeContinuationMessage({
        taskId: task.taskId,
        attempt,
        failureReason: currentRow?.failureReason ?? task.failureReason,
        gateFixInstructions: params.gateFixInstructions
      })
    } else {
      // Cold rung — byte-identical to pre-Phase-2 behaviour.
      failureMemoryExtraction = priorPartial?.contentMd
        ? await this.extractFailureMemoryIfEnabled({
            text: priorPartial.contentMd,
            gateReport: currentRow?.gatesJson ?? null,
            failureReason: currentRow?.failureReason ?? task.failureReason,
            blueprintId,
            taskId: task.taskId,
            workspaceId,
            attempt
          })
        : null
      taskContext = this.buildTaskContext(
        task,
        params.priorDiscoveries,
        priorPartial?.contentMd,
        task.failureReason,
        params.gateFixInstructions,
        modelConfigService.isLocalProvider(workspacePath),
        failureMemoryExtraction
      )
    }

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
    // GAP-A: the watchdog window comes from the provider timeout tier so it
    // always sits ABOVE the executor's stall windows for the same provider
    // (remote: 540s > 480s stall > 300s pre-activity) — on remote providers a
    // slow-but-alive turn gets the executor's in-stream retry first, and only
    // a task that stays silent past the tier window is failed here.
    const stallWatchdog = new PhaseActivityWatchdog(
      getTimeoutTier(!modelConfigService.isLocalProvider(workspacePath)).taskWatchdogMs,
      `BUILD-${task.taskId}`
    )

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
        if (isWriteTool(chunk.toolName)) {
          writeToolCalls++
          if (params.writeActivity) params.writeActivity.writeToolCalls++
          // F1 (step 2) — the same call, recorded by TARGET as well as by count.
          const written = writeToolTargetPath(chunk)
          if (written && params.writeActivity) params.writeActivity.writtenPaths.add(written)
        }
        if (isBashTool(chunk.toolName)) {
          bashCalls++
          if (params.writeActivity) params.writeActivity.bashCalls++
        }
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

    // Placeholder: every path below overwrites it. Classed 'infra' rather than
    // left bare so that if one ever does not, the result still carries a class —
    // an unclassified failure is the one thing routing cannot handle.
    let taskResult: TaskResult = {
      success: false,
      completion: null,
      discoveries: [],
      failureClass: 'infra'
    }
    // BP-CATCH-SCOPE-01: Declared outside try/catch so the catch block (which saves
    // partial output on failure) can read the same conversation id the try block used.
    // A1: stable across attempts within one generation — no `Date.now()`. The
    // generation suffix rotates ONLY when the ladder denies the resume permit,
    // so `context_overflow` / `turn_limit_exhausted` still get a fresh
    // conversation (never re-injecting the transcript that overflowed) while
    // overload/error retries keep the id, the persisted session id, and with
    // them the cache-read resume.
    const syntheticConvId =
      `blueprint-build-${blueprintId}-${task.taskId}` +
      (params.taskGeneration && params.taskGeneration > 0 ? `-g${params.taskGeneration}` : '')

    // A1 (Step 1) — BUILD never ensured a conversation row, so
    // `conversationRepository.updateSessionId` had nothing to write to and no
    // session id could ever survive an attempt boundary. The row is the
    // persistence substrate for resume; it is also what crash recovery
    // correlates the task transcript through — spec has done this since
    // BP-CONV-ENSURE. Idempotent, best-effort: a failed ensure logs and the
    // attempt proceeds cold (pre-A1 behaviour).
    blueprintService.ensurePhaseConversation(workspaceId, blueprintId, 'build', syntheticConvId)

    if (resuming) {
      bpLog.info(
        `[executeTask] Task ${task.taskId} attempt ${attempt} — RESUMING session ` +
          `${params.resumeSessionId} (conversation ${params.resumeConversationId})`
      )
    }

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
        trackOwner: blueprintTrackOwner(blueprintId),
        // A1 — the opt-in resume seam. `resumeConversationId` keys the session
        // map explicitly (the old code keyed on `_lastActiveConversationId`,
        // which start() had just nulled); the seeded id then resolves as
        // `fromMemory` in `resolveSession` and skips the cross-restart guard
        // that rejects accidental DB loads.
        ...(params.resumeSessionId && params.resumeConversationId
          ? {
              resumeSessionId: params.resumeSessionId,
              resumeConversationId: params.resumeConversationId
            }
          : {})
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
        // E11 — the watchdog itself stays pure (no DB, no clock it does not own),
        // so the row is written here, where blueprintId is in scope. `stalled` is
        // only true when the watchdog fired.
        if (stallWatchdog.stalled) {
          blueprintTelemetryRepository.record({
            blueprintId,
            kind: 'stall',
            phase: 'build',
            taskId: task.taskId,
            data: {
              stallTimeoutMs: getTimeoutTier(!modelConfigService.isLocalProvider(workspacePath))
                .taskWatchdogMs,
              writeToolCalls,
              bashCalls
            }
          })
        }
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
          failureReason: sendOutcome,
          failureClass: classifySendOutcome(sendOutcome),
          resumeSafe: isResumeSafeOutcome(sendOutcome),
          sendOutcome
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
        // P0: TASK-scoped, not attempt-scoped. The local counters are reset on
        // every `executeTask` call, so on any attempt that continues a previous
        // one they read zero for work that demonstrably happened. Falls back to
        // the locals for callers outside the gate ladder, where the two are equal.
        const cumulativeWriteToolCalls = params.writeActivity?.writeToolCalls ?? writeToolCalls
        const cumulativeBashCalls = params.writeActivity?.bashCalls ?? bashCalls
        const noWriteActivity = cumulativeWriteToolCalls === 0 && cumulativeBashCalls === 0
        // GLM-PROTOCOL-MISS-01: hoisted — the "wrote but didn't sign" recovery
        // below branches on it alongside the write counters. All-zero means the
        // verifier found no discrepancy it could name: no completion block, every
        // checkable planned file present, none fresh vs THIS attempt's dispatch
        // (files written by an earlier attempt of the same task read as stale).
        const allZero =
          verification.missingClaimed.length === 0 &&
          verification.staleClaimed.length === 0 &&
          verification.missingPlanned.length === 0

        // BP-VERIFY-UNPROVEN-01: "exists but not provably fresh" is not "missing".
        // An agent that inspects code, finds it already correct and declines to
        // rewrite it produces stale-only claims — identical on disk to an agent
        // that did nothing. The two are separated by write activity, not by mtime,
        // and not (as before) by pattern-matching the task description.
        if (verification.verdict === 'unproven' && !noWriteActivity) {
          bpLog.warn(
            `[executeTask] Task ${task.taskId} verification UNPROVEN — ` +
              `${verification.staleClaimed.length} claimed file(s) exist but are not fresh; ` +
              `task made ${cumulativeWriteToolCalls} write call(s) and ${cumulativeBashCalls} Bash call(s) — passing with warning`
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
        } else if (
          shouldPassProtocolMissAsUnproven({
            allZero,
            cumulativeWriteToolCalls,
            cumulativeBashCalls,
            hasPlannedFiles
          })
        ) {
          // GLM-PROTOCOL-MISS-01: "wrote but didn't sign". GLM-5.3 frequently
          // completes the work (write tools fire, planned files land on disk)
          // but ends the turn without the ```blueprint-phase-complete fence.
          // Before this branch that shape failed as `infra` + `resumeSafe` and
          // burned MAX_BUILDER_ATTEMPTS identical retries on a stochastic
          // protocol miss. Direct evidence of work — cumulative write/Bash
          // calls — plus every planned file present is the same evidence the
          // BP-VERIFY-UNPROVEN-01 branch above trusts; mtime freshness is only
          // a proxy for it (and attempt-scoped, so multi-attempt tasks read
          // stale). Zero-write tasks never reach here (`noWriteActivity` guard)
          // and still hard-fail in `shouldFailForNoWriteActivity`. VERIFY
          // re-checks the same files either way.
          bpLog.warn(
            `[executeTask] Task ${task.taskId} protocol miss — no completion block, ` +
              `but session performed ${cumulativeWriteToolCalls} write call(s) and ` +
              `${cumulativeBashCalls} Bash call(s) with all planned files present — ` +
              `passing as unproven instead of retrying`
          )
          const buildPhase = blueprintPhaseRepository.findByBlueprintAndPhase(blueprintId, 'build')
          if (buildPhase) {
            blueprintPhaseRepository.appendArtifact(buildPhase.id, {
              type: 'verification-warning',
              contentMd:
                `## Task ${task.taskId} — completed, completion block missing (unproven)\n\n` +
                `The session performed ${cumulativeWriteToolCalls} write tool call(s) and ` +
                `${cumulativeBashCalls} Bash call(s), and every planned file is present on ` +
                `disk, but the model never emitted the required ` +
                `\`\`\`blueprint-phase-complete block (protocol miss). The task is ` +
                `treated as complete — VERIFY still checks the same files.\n\n` +
                `**Planned files (${(task.filePathsJson ?? []).length}):**\n` +
                (task.filePathsJson ?? []).map((f) => `- \`${f}\``).join('\n') +
                '\n'
            })
          }
          taskDiscoveries.push(
            `Task ${task.taskId}: model skipped the blueprint-phase-complete block ` +
              `(protocol miss) — work accepted on write activity + file presence only.`
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
          const missingList =
            verification.missingClaimed.length > 0
              ? verification.missingClaimed
              : verification.missingPlanned
          if (allZero) {
            bpLog.error(
              `[executeTask] Task ${task.taskId} FAILED verification — no completion block ` +
                `in CLI output (protocol miss — model ended the turn without emitting ` +
                `the \`blueprint-phase-complete\` block; an API/transport error is only ` +
                `suspected when an executor error was recorded); ` +
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
                  `to verify. The model most likely ended its turn without emitting the ` +
                  `required \`\`\`blueprint-phase-complete\`\`\` block (a protocol miss); ` +
                  `an API/transport error is only suspected when the executor recorded ` +
                  `one. No file discrepancies were found.\n`
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
                `(protocol miss — model did not emit the blueprint-phase-complete block); ` +
                `no file discrepancies found`
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
            ? 'verification failed — no completion block in CLI output (protocol miss — model did not emit the required blueprint-phase-complete block)'
            : `verification failed — ${verifyFailParts.join(', ')}`

          // WAVE-RACE FIX: when the session never produced a completion block
          // AND the executor emitted an error, the error is the actionable
          // cause — the missing files are only the symptom of a session that
          // died before writing anything. GLM protocol miss (no executor error)
          // keeps the protocol-miss reason so telemetry/telemetry rows name the
          // real cause instead of blaming transport.
          const failureReason =
            !completion && executorErrorBox.value
              ? `executor error: ${executorErrorBox.value.slice(0, 200)}`
              : verifyFailReason

          taskResult = {
            success: false,
            completion,
            discoveries: taskDiscoveries,
            failureReason,
            // Either an executor error or files the session claimed but never
            // wrote: in both cases the work was never graded, so nothing is
            // known about its quality.
            failureClass: 'infra',
            // The transcript is intact — nothing overflowed and no turn budget
            // was exhausted — so a resume would pick up where this stopped.
            resumeSafe: true
          }
        } else {
          // If the completion claims files BUT the session never invoked a
          // write-capable tool, the files on disk are stale from a prior run.
          // Also fail when no completion + zero write calls + task has planned files.
          // This is the guard that keeps the R029 hole shut now that stale-only
          // claims no longer hard-fail on their own.
          // The diff is only consulted when the counters already point at a
          // failure — the happy path never pays for a git diff. See
          // `shouldFailForNoWriteActivity` for why the diff outranks the counters.
          const baselineDiffEmpty =
            noWriteActivity && params.baselineDiffEmpty ? await params.baselineDiffEmpty() : null
          if (baselineDiffEmpty === false) {
            bpLog.info(
              `[executeTask] Task ${task.taskId} recorded no write tools, but the gate ` +
                `baseline diff is non-empty — an earlier attempt's work stands, ` +
                `not a stale-file claim`
            )
          }

          if (
            shouldFailForNoWriteActivity({
              cumulativeWriteToolCalls,
              cumulativeBashCalls,
              claimedFiles,
              hasCompletion: Boolean(completion),
              hasPlannedFiles,
              baselineDiffEmpty
            })
          ) {
            bpLog.error(
              `[executeTask] Task ${task.taskId} FAILED — no-write-activity: ` +
                `claimed ${claimedFiles} file(s) but the task invoked 0 write tools and ` +
                `0 Bash calls across all attempts, and changed nothing since its baseline`
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
                  : 'no-write-activity',
              failureClass: 'infra',
              resumeSafe: true
            }
          } else {
            taskResult = {
              success: true,
              completion,
              discoveries: taskDiscoveries,
              outcomeKind:
                verification.preexistingClaimed.length > 0 && claimedFiles === 0
                  ? 'preexisting'
                  : // A2 — when the turn was rescued by a recovery nudge, say so
                    // on the row: the nudge rate per run is the metric this item
                    // exists to move, and `verified` alone would hide it.
                    // `preexisting`/`unproven` stay more specific than `nudged`
                    // and win when both apply.
                    session.wasNudged()
                    ? 'nudged'
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
      // A1-P6 — abort during SEND is a cancellation, not an infra failure. The
      // abort promise rejects with Error('Phase cancelled') into this catch; left
      // unclassed it lands `infra` + `resumeSafe: true`, so a user-cancelled phase
      // would later be re-driven as a resume. Only the workspace abort signal
      // counts — the stall watchdog and TASK_TIMEOUT_MS throw the same shape but
      // ARE infra (and resume-safe).
      const abortedDuringSend = blueprintService.getAbortSignal(workspaceId)?.aborted === true
      taskResult = {
        success: false,
        completion: null,
        discoveries: [],
        failureReason: err instanceof Error ? err.message : String(err),
        failureClass: abortedDuringSend ? 'aborted' : 'infra',
        // resumeSafe: false when aborted — a cancelled turn leaves an unanswered
        // user turn in the transcript (the poison rule), so it must never be
        // resumed. Otherwise: a stall or dead transport leaves the session's
        // history usable; the two outcomes that do not are handled on the
        // send-outcome path above.
        resumeSafe: !abortedDuringSend,
        // A1 (Phase 1) — a DISPATCHED turn that ends in a throw (stall watchdog,
        // TASK_TIMEOUT_MS, abort) is still live here; the fire-and-forget
        // stop() below will abort it and the turn boundary will poison the
        // session — AFTER this catch could ever read the set. Stamp it now,
        // optimistically-but-correctly: the id may still be in the map, but it
        // is about to point at a transcript with a dangling user turn. A
        // start() failure (no turn dispatched, tSessionReady === 0) leaves the
        // seeded id genuinely valid — no poison there.
        sessionPoisoned: tSessionReady !== 0
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

      // A1 (Phase 0) — capture the resume substrate SYNCHRONOUSLY, before the
      // fire-and-forget stop() below can tear the session down. stop() aborts
      // the active stream → recordTurnBoundary({aborted:true}) → poison rule →
      // sessionMap.delete + updateSessionId(convId, ''). Reading the DB here
      // would race exactly that; reading the live session map does not.
      taskResult.resumableSessionId = session.getSessionId(syntheticConvId)
      taskResult.executeAttempt = attempt
      // A1 (Phase 1) — consult the session's OWN poison set: an aborted or
      // zero-chunk turn leaves an unanswered user turn, and the id (if any
      // survived) must not be resumed. NOTE the asymmetry with the id above:
      // the catch block stamps `sessionPoisoned: true` directly when a turn was
      // dispatched — because THIS read happens before the fire-and-forget stop()
      // aborts the still-live stream, which would poison it only afterwards
      // (recordTurnBoundary runs inside the teardown, after the stamp). A
      // false positive here costs one cold retry (pre-A1 behaviour); a false
      // negative resumes a session with a dangling user turn — the replay
      // hazard. On the resolved paths (success / sendOutcome) the boundary has
      // already been recorded, so the set read IS the truth.
      taskResult.sessionPoisoned =
        taskResult.sessionPoisoned === true || session.isSessionPoisoned(syntheticConvId)
      // A1 (Phase 3) — what the executor actually did with a requested resume.
      taskResult.resumeOutcome = resuming ? session.getLastResumeOutcome() : 'none'
      // A1 (Phase 3) — cache-read tokens for this rung, straight off the token
      // tracker; this is what makes Gate 1 answerable without a join.
      taskResult.cacheReadInputTokens = session.getCacheReadTokens(syntheticConvId)

      // Phase 1.1: Take teardown OFF the critical path.
      // Resolve the task promise NOW (freeing the dispatch slot), then stop the
      // session fire-and-forget. The session remains in activeSessions until stop
      // settles so cancelBlueprint() can still find and kill it.
      // BP-SESSION-LEAK-01 preserved: stop() failure still triggers cleanup.
      // A1 (Phase 1) — the promise itself is stamped on the result: the ladder
      // awaits it ONLY before dispatching a resumed rung (P3 teardown race).
      taskResult.teardown = session
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

  // ── Failure Memory (P2) ──

  /**
   * P2 — flag-gated structured failure memory. Returns the rendered markdown
   * block, or null to leave the existing raw-dump path untouched.
   *
   * Every failure returns null rather than throwing: this sits on the critical
   * path of a retry, and an extractor that can break the retry it was meant to
   * improve is a worse trade than the raw dump it replaces.
   */
  private async extractFailureMemoryIfEnabled(params: {
    text: string
    gateReport: GateReport | null
    failureReason: string | null
    blueprintId: string
    taskId: string
    workspaceId: string
    /** Which attempt this memory is being built FOR — see R4. */
    attempt: number
  }): Promise<string | null> {
    if (!appPreferenceRepository.getAppPreferences().blueprintFailureMemory) return null
    try {
      const started = Date.now()
      const extracted = await extractFailureMemory(params)
      if (!extracted) return null
      const { memory } = extracted
      const rendered = renderFailureMemory(memory)
      // E11 — the success criterion is the resolution rate of the retries this
      // runs on, and the cost ceiling is Haiku staying under ~5% of build
      // tokens. Neither is answerable after the fact without a row per
      // extraction carrying both the attempt it fed and what it cost.
      blueprintTelemetryRepository.record({
        blueprintId: params.blueprintId,
        kind: 'failure_memory',
        phase: 'build',
        taskId: params.taskId,
        attempt: params.attempt,
        data: {
          rawChars: params.text.length,
          renderedChars: rendered.length,
          failingGate: memory.failingGate,
          filesTouched: memory.filesTouched.length,
          doNotRepeat: memory.doNotRepeat.length,
          durationMs: Date.now() - started,
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          costCents: extracted.costCents
        }
      })
      return rendered
    } catch (err) {
      bpLog.warn(`[executeTask] Task ${params.taskId} failure-memory extraction threw:`, err)
      return null
    }
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
    strictPacket?: boolean,
    /** P2 — rendered structured failure memory; supersedes the raw dump. */
    failureMemoryMd?: string | null
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

    // C3: the work packet, when the TASKS phase authored one. Rendered HERE —
    // after the task header, BEFORE the volatile retry context — so the bytes
    // up to and including the packet are identical between attempt 1 and every
    // later cold rung of this task. That is the prefix a provider KV-cache can
    // reuse; with the packet below the retry tail (its pre-C3 position, chosen
    // in M3.3 so a retry would read "what went wrong" first) the divergence
    // point moved EARLIER and every cold retry re-processed the packet too.
    // A1 is what un-blocks the flip: infra retries — the common case — now
    // RESUME with `buildResumeContinuationMessage`, which leads with the
    // failure verdict, so the cold path no longer has to carry that ordering
    // duty. `renderWorkPacket` is pure over `task.packetJson`, stable across
    // rungs by construction.
    const packet = renderWorkPacket(task.packetJson, { strict: strictPacket })
    if (packet) {
      lines.push('')
      lines.push(packet)
    }

    // BP-DISC-02: Thread accumulated discoveries into task context
    if (priorDiscoveries?.length) {
      lines.push('')
      lines.push('**Discoveries from earlier tasks**:')
      for (const d of priorDiscoveries.slice(-20)) {
        lines.push(`- ${d}`)
      }
    }

    // P2 — the structured memory REPLACES the raw dump; it never joins it.
    // Rendering both would spend more than today for the same information, and
    // the transcript tail is exactly the distractor the schema exists to drop.
    if (failureMemoryMd) {
      lines.push('')
      lines.push(failureMemoryMd)
    } else if (priorAttemptOutput) {
      // BP-RETRY-TASK-CONTEXT: Prior attempt output (on retry)
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

    // M4.1: gate evidence from the immediately preceding attempt. Late in the
    // prompt — on a retry it is the single most important thing in the prompt —
    // and the most volatile block (new evidence every rung), so the
    // cache-prefix argument of C3 wants it after the stable header. It is no
    // longer the FINAL block: the GLM-PROTOCOL-MISS-03 fence REMINDER line
    // below now closes the prompt (instruction recency), and that line is
    // static across rungs of a task — so keeping it last preserves the
    // cache-prefix argument (the volatile gate block stays above the shared
    // static tail).
    if (gateFixInstructions) {
      lines.push('')
      lines.push(gateFixInstructions)
    }

    // GLM-PROTOCOL-MISS-03: instruction recency. The fence requirement appears
    // exactly once, early, in the phase prompt — long-context models (GLM-5.3
    // on a 7–8 min build turn) drift off instructions stated 100K tokens ago
    // and end the turn without the block. Restating it as the FINAL line of the
    // task context puts the handshake at maximum recency for every cold rung.
    // The resumed path gets the same line via buildResumeContinuationMessage.
    lines.push('')
    lines.push(
      'REMINDER: when this task is done you MUST end your final message with a ' +
        '```blueprint-phase-complete fenced block (phase: "build") — the pipeline ' +
        'cannot grade the task without it.'
    )

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
