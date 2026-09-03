/**
 * Deterministic quality gates — kernel-owned, run in the MAIN process after a
 * build-task session ends. The graded agent never runs its own gates.
 *
 * Execution order is cheapest-first with a short-circuit on `fail`, so a task
 * that wrote outside its write-set never pays for a 30-minute build:
 *
 *   G4 write-set → G3 stub scan → G5 test integrity → G2 lint → G1 build → G6 task tests
 *
 * Two invariants hold everywhere in this file:
 *   1. A gate that could not RUN returns `unverifiable`, never `fail`.
 *   2. A gate that ran and the code failed returns `fail`, never `unverifiable`
 *      — a red test is never softened into a warning.
 *
 * @module blueprint-gates
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute } from 'node:path'
import log from 'electron-log'

import {
  boundEvidence,
  buildGateReport,
  type GateName,
  type GateReport,
  type GateResult,
  type GateVerdict,
  type UnverifiableReason
} from '../../shared/gate-types'
import {
  GATE_TIMEOUTS_MS,
  isSafeGateCommand,
  type GateCommandKind,
  type ResolvedGateCommand,
  type ResolvedGateCommands
} from '../../shared/gate-command-types'
import { buildTestCommand, detectTestToolchain } from '../../shared/gate-test-targeting'
import { pythonRunnerPrefix, type WorkspaceManifests } from '../../shared/gate-command-detect'
import {
  countTests,
  evaluateTestIntegrity,
  evaluateWriteSet,
  normalizePath,
  parseDiffAddedLines,
  pathMatches,
  scanAddedLinesForStubs,
  type AddedLine,
  type TestFileState
} from '../../shared/gate-analysis'
import type { BlueprintWorkPacket } from '../../shared/blueprint-types'

const gateLog = log.scope('blueprint-gates')

/** Per-file read cap for hashing and stub scanning. Beyond this, skip. */
const MAX_SCAN_BYTES = 1_000_000

/**
 * APP-BOOKKEEPING EXEMPTION: workspace paths the app itself writes during a
 * build — never the graded task's work. Prefix-matched (normalized, no leading
 * dot-slash) against every changed file in collectChanges.
 *
 * Deliberately does NOT include `blueprints/`. That directory is only the app's
 * when it is THIS blueprint's artifact dir; an unscoped entry would blind G4 to
 * every write under a workspace's own top-level `blueprints/` tree, including
 * another blueprint's artifacts. The scoped form arrives per-task as
 * `GateTaskContext.artifactPrefix`.
 */
const APP_BOOKKEEPING_PREFIXES: readonly string[] = ['.opencode/', '.pm-state/', '.atelierignore']
/** Git plumbing is fast; a hang here means a broken repo, not a slow one. */
const GIT_TIMEOUT_MS = 20_000
/** Output tail retained per command before `boundEvidence` trims further. */
const MAX_OUTPUT_TAIL_LINES = 40
/**
 * Ceiling for a `captureFull` read (git plumbing). Far above any real diff; it
 * exists so a pathological repo cannot exhaust memory. Crossing it reports a
 * spawn error rather than returning a short answer — see `captureFull`.
 */
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  'wasm',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'mp4',
  'mp3',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'node',
  'class',
  'jar',
  'pyc'
])

function isProbablyBinary(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? BINARY_EXTENSIONS.has(ext) : false
}

// ── Command execution ──

/**
 * R1.2 — per-worktree async mutex. Waves run parallel tasks in ONE shared
 * worktree, and gate commands (lint/build/test) are not safe to run
 * concurrently against the same tree: a build started mid-edit by a peer task
 * fails spuriously and burns retry-ladder budget on a lie. Every command gate
 * acquires this lock for its execution path, so command gates serialise per
 * tree while static analysis (pure diff parsing) stays parallel.
 *
 * The map holds one resolved promise per tree after the last waiter — bounded
 * by the number of distinct worktrees, so it is never cleaned up.
 */
const worktreeLocks = new Map<string, Promise<unknown>>()

/** Run `fn` holding the worktree lock for `key`. FIFO via promise chaining. */
async function withWorktreeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = worktreeLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  worktreeLocks.set(
    key,
    previous.then(() => gate)
  )
  await previous.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
  }
}

export interface CommandOutcome {
  /** Process exit code, or null when it was killed. */
  exitCode: number | null
  /** Combined stdout+stderr tail. */
  output: string[]
  timedOut: boolean
  /** Set when the process could not be spawned at all. */
  spawnError?: string
  durationMs: number
}

/** Injectable so gate tests never spawn a real toolchain. */
export type CommandRunner = (
  command: string,
  opts: {
    cwd: string
    timeoutMs: number
    signal?: AbortSignal
    /**
     * Return the command's COMPLETE output instead of the evidence tail.
     *
     * The tail is right for lint/build/test — the end of a compiler log is the
     * summary. It is catastrophically wrong for git plumbing, whose output IS
     * the data: a 40-line tail of `git status --porcelain` drops every dirty
     * file but the last 40, so those files stop being recognised as
     * pre-existing and G4 attributes the user's own uncommitted edits to the
     * task. The same tail applied to `git diff` starts the parse mid-hunk.
     * Only `git()` sets this.
     */
    captureFull?: boolean
  }
) => Promise<CommandOutcome>

/**
 * Default runner. `shell: true` is required for `npm run …` and Windows `.cmd`
 * shims to resolve; the command string has already passed `isSafeGateCommand`,
 * which rejects every metacharacter that could chain a second command.
 */
export const defaultCommandRunner: CommandRunner = (command, opts) =>
  new Promise<CommandOutcome>((resolvePromise) => {
    const startedAt = Date.now()
    const lines: string[] = []
    // captureFull path: keep the raw bytes and split ONCE at the end. Splitting
    // per chunk would cut a line — or a multi-byte character — at every 64KB
    // stream boundary, which is exactly how an accented path gets mangled.
    const rawChunks: Buffer[] = []
    let rawBytes = 0
    let overflowed = false
    let timedOut = false

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, {
        cwd: opts.cwd,
        shell: true,
        windowsHide: true,
        env: process.env
      })
    } catch (err) {
      resolvePromise({
        exitCode: null,
        output: [],
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt
      })
      return
    }

    const push = (chunk: Buffer | string, isStdout: boolean): void => {
      if (opts.captureFull) {
        // stdout ONLY. git writes advisory warnings to stderr (`LF will be
        // replaced by CRLF`, detached-HEAD notes), and interleaving one into a
        // NUL-separated listing turns it into a bogus path record.
        if (!isStdout) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf-8')
        rawBytes += buf.length
        if (rawBytes > MAX_CAPTURE_BYTES) {
          overflowed = true
          return
        }
        rawChunks.push(buf)
        return
      }
      for (const line of String(chunk).split('\n')) {
        if (line.trim() === '') continue
        lines.push(line)
        // Keep only the tail: the end of a compiler log is where the summary is,
        // and an unbounded buffer on a runaway watch task is a memory leak.
        if (lines.length > MAX_OUTPUT_TAIL_LINES * 4) {
          lines.splice(0, lines.length - MAX_OUTPUT_TAIL_LINES * 2)
        }
      }
    }
    // Merged for evidence (a compiler writes errors to stderr); split for
    // `captureFull`, where the two streams are not interchangeable.
    child.stdout?.on('data', (chunk) => push(chunk, true))
    child.stderr?.on('data', (chunk) => push(chunk, false))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    const onAbort = (): void => {
      timedOut = true
      child.kill('SIGKILL')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    let settled = false
    const finish = (exitCode: number | null, spawnError?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolvePromise({
        exitCode,
        output: opts.captureFull
          ? Buffer.concat(rawChunks).toString('utf-8').split('\n')
          : lines.slice(-MAX_OUTPUT_TAIL_LINES),
        timedOut,
        // An overflow is reported as a spawn failure so `git()` returns null and
        // the diff-derived gates go `unverifiable` — never a short answer that
        // silently reads as "nothing else changed".
        spawnError: spawnError ?? (overflowed ? 'output exceeded capture limit' : undefined),
        durationMs: Date.now() - startedAt
      })
    }

    child.on('error', (err) => finish(null, err.message))
    child.on('close', (code) => finish(code))
  })

/** Run a git subcommand. Returns null when git is unavailable or the call fails. */
async function git(
  args: string[],
  cwd: string,
  runner: CommandRunner,
  signal?: AbortSignal
): Promise<string | null> {
  // Args are internal constants plus repo-relative paths; nothing user-authored
  // reaches here, and `--` terminates option parsing before any path.
  const outcome = await runner(`git ${args.join(' ')}`, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
    // Plumbing output is data, not evidence: it must never be tail-trimmed.
    captureFull: true
  })
  if (outcome.spawnError || outcome.exitCode !== 0) return null
  return outcome.output.join('\n')
}

// ── Context & baseline ──

export interface GateTaskContext {
  blueprintId: string
  taskId: string
  /** Repo root — where gate commands run unless a command names its own cwd. */
  workspacePath: string
  /** Where the task actually executed. Equals workspacePath outside a worktree. */
  executionPath: string
  /** Task-level planned files, unioned into the allowed write-set. */
  plannedFiles: readonly string[]
  packet?: BlueprintWorkPacket | null
  commands: ResolvedGateCommands
  /**
   * R3.1 — manifest snapshot for test-toolchain detection. Supplied by the
   * build service from the same read used for gate-command detection; absent
   * for callers that have no manifests (template targeting then degrades to
   * `no_command`, which is honest).
   */
  manifests?: WorkspaceManifests
  /**
   * R3.3 — when true, this task's lint/build gates are omitted: they run ONCE
   * at wave level (see `runWaveCommandGates`) after every task in the wave has
   * settled. A per-task lint/build in a shared worktree measures peers'
   * mid-flight edits, so wave-level is both cheaper and correctly attributed.
   */
  skipCommandGates?: boolean
  /**
   * R1.2 — parallel-wave attribution: files declared by OTHER tasks currently
   * in flight in the same worktree. Their changes are visible in this task's
   * diff but are not this task's work, so `collectChanges` subtracts them
   * exactly as it subtracts `preexistingDirty`. Supplied by the wave scheduler
   * at gate time; absent for serial/legacy callers (empty = no exemption).
   */
  exemptFiles?: readonly string[]
  /**
   * This blueprint's artifact directory (`blueprints/<shortName|id>`), exempted
   * like the other app-bookkeeping prefixes: the pipeline rewrites plan.md /
   * tasks.md / spec.md there while the task runs, after the baseline snapshot.
   *
   * Scoped to the ACTIVE blueprint on purpose — exempting all of `blueprints/`
   * would also excuse writes to a sibling blueprint's artifacts and to any
   * `blueprints/` directory the workspace happens to own itself.
   */
  artifactPrefix?: string
  signal?: AbortSignal
  /** Test seam. Defaults to the real spawner. */
  runner?: CommandRunner
}

export interface GateBaseline {
  /** Commit the task started from — the diff base. */
  baselineCommit: string | null
  /** Files already dirty before the task began; their changes are not this task's. */
  preexistingDirty: string[]
  /** Packet test files as they were before the session. */
  testsBefore: Record<string, TestFileState>
  /** Whether the packet's tests were red before the session (the red proof). */
  redProof: 'red' | 'green' | 'unavailable'
  redEvidence: string[]
}

function hashFile(absPath: string): TestFileState | null {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null
    const content = readFileSync(absPath, 'utf-8')
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      testCount: countTests(content)
    }
  } catch {
    return null
  }
}

/**
 * Split a NUL-separated git listing (`-z`) into normalized paths.
 *
 * `-z` is not a nicety: `core.quotePath` defaults to true, so the line-based
 * form renders `src/Café.cs` as `"src/Caf\303\251.cs"` — a string that matches
 * nothing, so the real path is never recognised as already-dirty or as
 * untracked. `-z` emits the raw bytes with NUL separators and no quoting.
 */
function splitNulPaths(raw: string): string[] {
  return raw
    .split('\0')
    .filter((p) => p !== '')
    .map((p) => normalizePath(p))
}

/**
 * Parse `git status --porcelain -uall -z` into post-image paths.
 *
 * Each record is `XY <path>` NUL-terminated. In `-z` form the ` -> ` of a
 * rename/copy is gone and the two paths are swapped into separate fields:
 * `R  <to>\0<from>\0`. The pre-image field must be consumed, not read as its
 * own record — otherwise it lands in the list with its status bytes sliced off
 * the front of the path.
 */
function parseStatusZ(raw: string): string[] {
  const tokens = raw.split('\0')
  const out: string[] = []
  let i = 0
  while (i < tokens.length) {
    const entry = tokens[i]
    if (!entry) {
      i += 1
      continue
    }
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (path) out.push(normalizePath(path))
    // The extra field belongs to the record, so skip it: the pre-image of a
    // rename is not a path that exists in the tree now.
    i += status.includes('R') || status.includes('C') ? 2 : 1
  }
  return out
}

/** Resolve a repo-relative packet path against the execution root, refusing escapes. */
function resolveInside(root: string, candidate: string): string | null {
  const abs = isAbsolute(candidate) ? candidate : resolve(root, candidate)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return abs
}

/**
 * Capture everything the post-session gates need to compare against.
 * Must be called BEFORE the build session starts.
 *
 * Nothing here mutates the repo: the baseline is a commit id plus a list of
 * already-dirty paths, so a task that runs against a dirty tree is still gated
 * on its own changes rather than on whatever the user left uncommitted.
 */
export async function captureGateBaseline(ctx: GateTaskContext): Promise<GateBaseline> {
  const runner = ctx.runner ?? defaultCommandRunner
  const cwd = ctx.executionPath

  const head = await git(['rev-parse', 'HEAD'], cwd, runner, ctx.signal)
  const status = await git(['status', '--porcelain', '-uall', '-z'], cwd, runner, ctx.signal)

  const preexistingDirty = parseStatusZ(status ?? '')

  const testsBefore: Record<string, TestFileState> = {}
  for (const rel of ctx.packet?.testFiles ?? []) {
    const abs = resolveInside(cwd, rel)
    if (!abs) continue
    const state = hashFile(abs)
    if (state) testsBefore[normalizePath(rel)] = state
  }

  const { redProof, redEvidence } = await captureRedProof(ctx, runner)

  return {
    baselineCommit: head?.trim().split('\n')[0] ?? null,
    preexistingDirty,
    testsBefore,
    redProof,
    redEvidence
  }
}

/**
 * Run the packet's tests BEFORE the session to prove they actually fail.
 *
 * A test that was already green cannot prove the task did anything — it is
 * recorded as `vacuous_test` in the ledger rather than counted as evidence.
 */
async function captureRedProof(
  ctx: GateTaskContext,
  runner: CommandRunner
): Promise<{ redProof: GateBaseline['redProof']; redEvidence: string[] }> {
  // R1.4: with the full-suite fallback gone, a packet without `testFiles` has no
  // per-task tests whose red state could be proven. Running anything here would
  // execute a command that cannot produce evidence for THIS task.
  if (!ctx.packet?.testFiles?.length) {
    return { redProof: 'unavailable', redEvidence: ['packet declares no test files'] }
  }
  const command = taskTestCommand(ctx)
  if (!command) return { redProof: 'unavailable', redEvidence: ['no task test command'] }

  // R1.2: red-proof runs happen while peer tasks are still editing the shared
  // worktree — they take the same per-tree lock as the post-session gates.
  const outcome = await withWorktreeLock(ctx.executionPath, () =>
    runner(command.command, {
      cwd: commandCwd(ctx, command),
      timeoutMs: GATE_TIMEOUTS_MS.test,
      signal: ctx.signal
    })
  )

  if (outcome.spawnError || outcome.timedOut) {
    return {
      redProof: 'unavailable',
      redEvidence: [outcome.spawnError ?? 'pre-session test run timed out']
    }
  }
  return {
    redProof: outcome.exitCode === 0 ? 'green' : 'red',
    redEvidence: outcome.output.slice(-5)
  }
}

/**
 * The command that runs THIS TASK's tests.
 *
 * File-targeting syntax is runner-specific (`vitest path`, `dotnet test --filter`,
 * `pytest path`, `npm test -- path`), so this never synthesises it. The packet
 * declares `testCommand` when it wants a narrow run; otherwise the full resolved
 * test command is used. Guessing the syntax would produce a spawn error that
 * looks exactly like a red test.
 *
 * R1.4: the full-suite fallback is GONE. Without a packet `testCommand` there is
 * no honest per-task test claim to make — G6 reports `unverifiable`/`no_command`
 * and the full suite runs in VERIFY where it belongs.
 *
 * R1.1 (defence-in-depth): a packet `testCommand` that fails `isSafeGateCommand`
 * is treated as absent. `extractWorkPacket` already drops those at parse time;
 * this re-check covers packets that reached the DB before that guard existed,
 * or were assembled by another path. An unsafe command must never reach the
 * shell — reporting `no_command` is the honest, safe degradation.
 */
function taskTestCommand(ctx: GateTaskContext): ResolvedGateCommand | undefined {
  const packetCommand = ctx.packet?.testCommand?.trim()
  if (packetCommand) {
    if (!isSafeGateCommand(packetCommand)) {
      gateLog.warn(
        `[taskTestCommand] packet testCommand for ${ctx.taskId} failed the safety guard — treating as absent`
      )
      return undefined
    }
    return { command: packetCommand, provenance: 'declared' }
  }

  // R3.1 — ecosystem template (M2.6 Option 2): when the packet declares test
  // FILES but no command, build a narrow per-task command from the detected
  // toolchain. The full suite is never used here — that is VERIFY's job (M8).
  const testFiles = ctx.packet?.testFiles
  if (testFiles?.length) {
    const toolchain = ctx.manifests ? detectTestToolchain(ctx.manifests) : null
    // Same environment-aware runner chain as the full-suite gate: a bare
    // `pytest` template is unverifiable-by-construction inside a worktree
    // whose .gitignored venv never made it there.
    const pythonPrefix = ctx.manifests ? pythonRunnerPrefix(ctx.manifests) : ''
    const template = buildTestCommand(toolchain ?? undefined, testFiles, pythonPrefix)
    if (template) {
      if (!isSafeGateCommand(template)) {
        gateLog.warn(
          `[taskTestCommand] generated template failed the safety guard for ${ctx.taskId} — treating as absent`
        )
        return undefined
      }
      return { command: template, provenance: 'detected' }
    }
  }
  return undefined
}

function commandCwd(ctx: GateTaskContext, command: ResolvedGateCommand): string {
  return command.cwd ? join(ctx.executionPath, command.cwd) : ctx.executionPath
}

// ── Gate result helpers ──

function result(
  name: GateName,
  verdict: GateVerdict,
  evidence: string[],
  extra?: { reason?: UnverifiableReason; counts?: Record<string, number>; durationMs?: number }
): GateResult {
  return {
    name,
    verdict,
    evidence: boundEvidence(evidence),
    ...(extra?.reason ? { reason: extra.reason } : {}),
    ...(extra?.counts ? { counts: extra.counts } : {}),
    durationMs: extra?.durationMs ?? 0
  }
}

const unverifiable = (
  name: GateName,
  reason: UnverifiableReason,
  evidence: string[],
  durationMs = 0
): GateResult => result(name, 'unverifiable', evidence, { reason, durationMs })

/**
 * Shell signatures of "the runner itself is not installed on this machine".
 *
 * With `shell: true` a missing binary is NOT a spawnError — the shell starts
 * fine and exits 1, so `exitCode !== 0` alone cannot distinguish a red suite
 * from an absent tool. These strings can (incident 2026-08: bare `pytest` on a
 * machine with no PATH pytest failed ~20 consecutive BUILD retries, each in
 * <100ms, because the shell's "'pytest' is not recognized" line was captured
 * but never inspected).
 */
const MISSING_COMMAND_SIGNATURES = [
  'is not recognized as', // cmd.exe / PowerShell
  'command not found', // sh / bash / zsh
  'no module named' // `python -m <runner>` with the runner absent
] as const

/** True when the output shows the command's binary was never executed. */
function isCommandMissing(output: readonly string[]): boolean {
  // Only the first two lines are scanned: every shell prints its "not found"
  // signature as the FIRST line of output, before any runner header. A red
  // suite's assertion text can legitimately quote those strings (a test
  // asserting on subprocess error text) — that appears AFTER the header, and
  // matching it would flip a real regression to `unverifiable`, failing open.
  return output
    .slice(0, 2)
    .some((line) => MISSING_COMMAND_SIGNATURES.some((sig) => line.toLowerCase().includes(sig)))
}

// ── Change collection ──

/** Why a changed path was not attributed to the graded task. */
type ExemptionReason = 'preexisting' | 'peer' | 'bookkeeping'

interface ChangeSet {
  files: string[]
  addedLines: AddedLine[]
  /** Set when git could not answer — every diff-derived gate goes unverifiable. */
  unavailable?: string
  /**
   * Paths the attribution filter dropped, by reason. Observability only: an
   * over-broad exemption swallowing a real violation is otherwise completely
   * invisible, which is how a dead `blueprints/` entry survived unnoticed.
   */
  exempted: Record<ExemptionReason, string[]>
}

/**
 * Files and added lines produced by this task, relative to the baseline commit.
 *
 * Diffing against the baseline COMMIT rather than HEAD means a task that
 * committed its own work is still measured. Files that were already dirty are
 * subtracted: their changes are not this task's, and blaming a task for the
 * user's uncommitted edits is a false `fail`.
 */
async function collectChanges(
  ctx: GateTaskContext,
  baseline: GateBaseline,
  runner: CommandRunner
): Promise<ChangeSet> {
  const cwd = ctx.executionPath
  const noExemptions: Record<ExemptionReason, string[]> = {
    preexisting: [],
    peer: [],
    bookkeeping: []
  }
  if (!baseline.baselineCommit) {
    return {
      files: [],
      addedLines: [],
      unavailable: 'no git baseline commit',
      exempted: noExemptions
    }
  }

  const diff = await git(
    ['diff', '-U0', '--no-color', baseline.baselineCommit, '--'],
    cwd,
    runner,
    ctx.signal
  )
  if (diff === null) {
    return { files: [], addedLines: [], unavailable: 'git diff failed', exempted: noExemptions }
  }

  const untracked = splitNulPaths(
    (await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, runner, ctx.signal)) ?? ''
  )

  const dirtyBefore = new Set(baseline.preexistingDirty)
  // R1.2 — parallel-wave attribution: peer in-flight tasks' declared files are
  // subtracted exactly like pre-existing dirt. Without this, a parallel wave in
  // one shared worktree attributes every peer's writes to every task, and G4
  // fails all of them for writes outside their write-set.
  // APP-BOOKKEEPING EXEMPTION: files the APP itself writes into the workspace
  // during task execution — opencode agent/command definitions (rewritten at
  // every session start), blueprint phase artifacts (plan/tasks/spec updated as
  // the pipeline progresses), and process-manager state. These are not the
  // graded task's work, yet they land after the baseline snapshot, so without
  // this exemption G4 attributes them to whichever task is being gated
  // (live evidence: T004 wrote 13 files, status passed, gate failed on
  // .opencode/agents/davinci.md + blueprints/<id>/plan.md).
  // Peer `exemptFiles` are exact paths (a peer declaring `src/` must not exempt
  // this task's `src/other.ts`); the bookkeeping entries are directory
  // prefixes, so they need `pathMatches`, not set equality — no changed file is
  // ever literally named `.opencode/`.
  const exemptExact = new Set((ctx.exemptFiles ?? []).map(normalizePath))
  const bookkeepingPrefixes = ctx.artifactPrefix
    ? [...APP_BOOKKEEPING_PREFIXES, normalizePath(ctx.artifactPrefix)]
    : APP_BOOKKEEPING_PREFIXES

  const exempted: Record<ExemptionReason, string[]> = {
    preexisting: [],
    peer: [],
    bookkeeping: []
  }
  const seenExempt = new Set<string>()
  const notThisTasks = (f: string): boolean => {
    const reason: ExemptionReason | null = dirtyBefore.has(f)
      ? 'preexisting'
      : exemptExact.has(f)
        ? 'peer'
        : bookkeepingPrefixes.some((p) => pathMatches(f, p))
          ? 'bookkeeping'
          : null
    if (!reason) return false
    // Called once per diff line, so record each path once.
    if (!seenExempt.has(f)) {
      seenExempt.add(f)
      exempted[reason].push(f)
    }
    return true
  }
  const addedLines = parseDiffAddedLines(diff).filter((l) => !notThisTasks(l.file))

  // An untracked file has no diff hunk — every line of it is an addition.
  for (const rel of untracked) {
    if (notThisTasks(rel) || isProbablyBinary(rel)) continue
    const abs = resolveInside(cwd, rel)
    if (!abs) continue
    try {
      if (statSync(abs).size > MAX_SCAN_BYTES) continue
      const content = readFileSync(abs, 'utf-8')
      content.split('\n').forEach((text, i) => addedLines.push({ file: rel, line: i + 1, text }))
    } catch {
      // Unreadable file — it still counts as changed, just not as scannable lines.
    }
  }

  const files = [...new Set([...addedLines.map((l) => l.file), ...untracked])].filter(
    (f) => !notThisTasks(f)
  )

  if (exempted.bookkeeping.length > 0) {
    gateLog.debug(
      `[${ctx.taskId}] app-bookkeeping exemption dropped ${exempted.bookkeeping.length} ` +
        `path(s): ${exempted.bookkeeping.join(', ')}`
    )
  }

  return { files, addedLines, exempted }
}

/**
 * Did this task change anything on disk, relative to the baseline it started
 * from? `true` = nothing changed, `false` = something did, `null` = git could
 * not answer (no baseline commit, or the diff failed).
 *
 * The three-valued return is the point. This exists for the no-write-activity
 * guard, whose per-attempt write-tool counter cannot see work an EARLIER
 * attempt of the same task did — and a caller that collapses "unknown" into
 * "nothing changed" would fail exactly the tasks whose evidence is missing.
 *
 * Reuses `collectChanges`, so the same attribution rules apply: pre-existing
 * dirt, peers' declared files and app bookkeeping are not this task's work.
 * That is what makes an empty result mean "this task wrote nothing" rather than
 * "the tree happens to be clean".
 */
export async function isBaselineDiffEmpty(
  ctx: GateTaskContext,
  baseline: GateBaseline
): Promise<boolean | null> {
  const changes = await collectChanges(ctx, baseline, ctx.runner ?? defaultCommandRunner)
  if (changes.unavailable) return null
  return changes.files.length === 0
}

// ── The gates ──

function gateWriteSet(ctx: GateTaskContext, changes: ChangeSet): GateResult {
  const started = Date.now()
  if (changes.unavailable) {
    return unverifiable('write-set', 'no_git', [changes.unavailable], Date.now() - started)
  }
  const packet = ctx.packet
  if (!packet?.allowedFiles?.length && ctx.plannedFiles.length === 0) {
    return unverifiable(
      'write-set',
      'no_packet',
      ['task declares neither a work packet write-set nor planned files'],
      Date.now() - started
    )
  }

  const evaluation = evaluateWriteSet({
    changedFiles: changes.files,
    allowedFiles: [...(packet?.allowedFiles ?? []), ...ctx.plannedFiles],
    testFiles: packet?.testFiles,
    forbiddenFiles: packet?.forbiddenFiles
  })

  // Exemption counts ride along so an over-broad exemption is visible in the
  // report instead of only in the absence of a violation. Zero-valued keys are
  // omitted to keep the common report clean.
  const exempted = changes.exempted
  const counts = {
    changed: evaluation.changedCount,
    violations: evaluation.violations.length,
    forbidden: evaluation.forbidden.length,
    ...(exempted.preexisting.length > 0 ? { exemptPreexisting: exempted.preexisting.length } : {}),
    ...(exempted.peer.length > 0 ? { exemptPeer: exempted.peer.length } : {}),
    ...(exempted.bookkeeping.length > 0 ? { exemptBookkeeping: exempted.bookkeeping.length } : {})
  }

  if (evaluation.forbidden.length > 0 || evaluation.violations.length > 0) {
    return result(
      'write-set',
      'fail',
      [
        ...evaluation.forbidden.map((f) => `forbidden: ${f}`),
        ...evaluation.violations.map((f) => `outside write-set: ${f}`)
      ],
      { counts, durationMs: Date.now() - started }
    )
  }

  return result('write-set', 'pass', [`${evaluation.changedCount} file(s) changed, all in set`], {
    counts,
    durationMs: Date.now() - started
  })
}

function gateStubScan(ctx: GateTaskContext, changes: ChangeSet): GateResult {
  const started = Date.now()
  if (changes.unavailable) {
    return unverifiable('stub-scan', 'no_git', [changes.unavailable], Date.now() - started)
  }

  const testFiles = new Set((ctx.packet?.testFiles ?? []).map(normalizePath))
  // Test files legitimately contain the markers this gate hunts for — a test
  // named "returns null when unimplemented" is not unfinished work.
  const scannable = changes.addedLines.filter(
    (l) => !testFiles.has(l.file) && !isProbablyBinary(l.file)
  )
  const findings = scanAddedLinesForStubs(scannable)

  if (findings.length > 0) {
    return result(
      'stub-scan',
      'fail',
      findings.slice(0, 20).map((f) => `${f.file}:${f.line} [${f.kind}] ${f.snippet}`),
      { counts: { findings: findings.length }, durationMs: Date.now() - started }
    )
  }
  return result('stub-scan', 'pass', [`${scannable.length} added line(s) scanned`], {
    counts: { findings: 0 },
    durationMs: Date.now() - started
  })
}

function gateTestIntegrity(
  ctx: GateTaskContext,
  baseline: GateBaseline,
  changes: ChangeSet
): GateResult {
  const started = Date.now()
  const declared = ctx.packet?.testFiles ?? []
  if (declared.length === 0) {
    return unverifiable(
      'test-integrity',
      'no_packet',
      ['task packet declares no test files'],
      Date.now() - started
    )
  }
  if (Object.keys(baseline.testsBefore).length === 0) {
    return unverifiable(
      'test-integrity',
      'no_tests',
      [`none of the ${declared.length} declared test file(s) existed before the session`],
      Date.now() - started
    )
  }

  const after: Record<string, TestFileState | null> = {}
  for (const rel of Object.keys(baseline.testsBefore)) {
    const abs = resolveInside(ctx.executionPath, rel)
    after[rel] = abs && existsSync(abs) ? hashFile(abs) : null
  }

  const testFileSet = new Set(Object.keys(baseline.testsBefore))
  const evaluation = evaluateTestIntegrity({
    before: baseline.testsBefore,
    after,
    addedTestLines: changes.addedLines.filter((l) => testFileSet.has(l.file))
  })

  if (!evaluation.ok) {
    return result(
      'test-integrity',
      'fail',
      [
        ...evaluation.deleted.map((f) => `test file deleted: ${f}`),
        ...evaluation.modified.map((f) => `test file modified: ${f}`),
        ...evaluation.countDrops.map(
          (d) => `test count dropped in ${d.file}: ${d.before} → ${d.after}`
        ),
        ...evaluation.skipsAdded.map((s) => `test disabled at ${s.file}:${s.line} — ${s.snippet}`)
      ],
      {
        counts: {
          modified: evaluation.modified.length,
          deleted: evaluation.deleted.length,
          skipsAdded: evaluation.skipsAdded.length
        },
        durationMs: Date.now() - started
      }
    )
  }

  // EXTENSION ALLOWANCE: extended files are visible as info, not failures —
  // authoring new tests inside a packet-declared file is a legitimate
  // deliverable (T001 shape), and the builder needs to see it was recognized.
  const extensionLines = evaluation.extended.map((f) => {
    const beforeState = baseline.testsBefore[f]
    const afterState = after[f]
    return `test file extended ${beforeState?.testCount}→${afterState?.testCount} tests — authoring allowed: ${f}`
  })

  return result(
    'test-integrity',
    'pass',
    [
      `${declared.length} test file(s) intact`,
      ...extensionLines
    ],
    {
      durationMs: Date.now() - started
    }
  )
}

/** Shared shape for the two command-driven gates (lint, build). */
async function gateCommand(
  name: GateName,
  kind: GateCommandKind,
  ctx: GateTaskContext,
  runner: CommandRunner
): Promise<GateResult> {
  const started = Date.now()
  const command = ctx.commands[kind]
  if (!command) {
    return unverifiable(
      name,
      'no_command',
      [`no ${kind} command resolved (override → declared → detected all empty)`],
      Date.now() - started
    )
  }

  // R1.2: lint/build run against the shared worktree — serialise per tree so a
  // peer task's mid-edit state cannot produce a spurious fail.
  const outcome = await withWorktreeLock(ctx.executionPath, () =>
    runner(command.command, {
      cwd: commandCwd(ctx, command),
      timeoutMs: GATE_TIMEOUTS_MS[kind],
      signal: ctx.signal
    })
  )

  if (outcome.spawnError) {
    return unverifiable(
      name,
      'command_error',
      [`${command.command}: ${outcome.spawnError}`],
      outcome.durationMs
    )
  }
  if (outcome.timedOut) {
    // A timeout is genuinely unknown: the command may have been about to pass.
    // Calling it `fail` would burn the retry ladder on a slow machine.
    return unverifiable(
      name,
      'timeout',
      [`${command.command} exceeded ${GATE_TIMEOUTS_MS[kind]}ms`],
      outcome.durationMs
    )
  }
  if (outcome.exitCode !== 0) {
    // A missing runner is environmental, not a code failure: grading it `fail`
    // fails the phase deterministically and no retry can ever change it.
    if (isCommandMissing(outcome.output)) {
      return unverifiable(
        name,
        'command_missing',
        [
          `${command.command} — the runner is not installed on this machine`,
          ...outcome.output
        ],
        outcome.durationMs
      )
    }
    return result(
      name,
      'fail',
      [`${command.command} exited ${outcome.exitCode}`, ...outcome.output],
      {
        counts: { exitCode: outcome.exitCode ?? -1 },
        durationMs: outcome.durationMs
      }
    )
  }
  return result(name, 'pass', [`${command.command} (${command.provenance})`], {
    durationMs: outcome.durationMs
  })
}

/**
 * G6 — the task's own tests, with red→green proof.
 *
 * A timeout here IS a failure, unlike lint/build: the contract is "these tests
 * are green when the task is done", and a suite that never finished is not
 * green. The `unverifiable` escape only covers "there was no command to run".
 */
async function gateTaskTests(
  ctx: GateTaskContext,
  baseline: GateBaseline,
  runner: CommandRunner
): Promise<GateResult> {
  const started = Date.now()
  const command = taskTestCommand(ctx)
  if (!command) {
    return unverifiable(
      'task-tests',
      'no_command',
      ['no test command resolved for this task'],
      Date.now() - started
    )
  }

  // R1.2: same per-tree lock as lint/build — the task's own tests also read the
  // tree the peer tasks are editing.
  const outcome = await withWorktreeLock(ctx.executionPath, () =>
    runner(command.command, {
      cwd: commandCwd(ctx, command),
      timeoutMs: GATE_TIMEOUTS_MS.test,
      signal: ctx.signal
    })
  )

  if (outcome.spawnError) {
    return unverifiable(
      'task-tests',
      'command_error',
      [`${command.command}: ${outcome.spawnError}`],
      outcome.durationMs
    )
  }
  if (outcome.exitCode !== 0 || outcome.timedOut) {
    // Same environmental distinction as `gateCommand`: a task-test command whose
    // binary is absent is `unverifiable`, never a red-suite `fail`.
    if (!outcome.timedOut && isCommandMissing(outcome.output)) {
      return unverifiable(
        'task-tests',
        'command_missing',
        [
          `${command.command} — the runner is not installed on this machine`,
          ...outcome.output
        ],
        outcome.durationMs
      )
    }
    return result(
      'task-tests',
      'fail',
      [
        outcome.timedOut
          ? `${command.command} timed out — the suite is not green`
          : `${command.command} exited ${outcome.exitCode}`,
        ...outcome.output
      ],
      { counts: { exitCode: outcome.exitCode ?? -1 }, durationMs: outcome.durationMs }
    )
  }

  // Green after. Whether that PROVES anything depends on the red proof.
  if (baseline.redProof === 'green') {
    return unverifiable(
      'task-tests',
      'vacuous_test',
      [
        `${command.command} passed, but it also passed BEFORE the task ran`,
        'a test that was never red cannot prove this task did anything'
      ],
      outcome.durationMs
    )
  }
  if (baseline.redProof === 'unavailable') {
    return unverifiable(
      'task-tests',
      'no_tests',
      [`${command.command} passed, but no red proof was captured`, ...baseline.redEvidence],
      outcome.durationMs
    )
  }

  return result('task-tests', 'pass', [`${command.command} — red before, green after`], {
    durationMs: Date.now() - started
  })
}

// ── Affected-test selection (M2.6) ──

/**
 * Test files worth re-running for a change, cheapest source first.
 *
 * Returns paths only. It deliberately does NOT build a command: targeting
 * syntax differs per runner, so the caller either has a packet `testCommand`
 * that knows how, or runs the full suite.
 */
export function selectAffectedTestFiles(
  changedFiles: readonly string[],
  packetTestFiles: readonly string[] | undefined,
  callersOf?: (file: string) => string[]
): string[] {
  const out = new Set<string>((packetTestFiles ?? []).map(normalizePath))
  if (callersOf) {
    for (const file of changedFiles) {
      for (const caller of callersOf(file)) {
        const norm = normalizePath(caller)
        if (/(^|\/)(__tests__|tests?)\//.test(norm) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(norm)) {
          out.add(norm)
        }
      }
    }
  }
  return [...out]
}

// ── Orchestration ──

/**
 * R3.3 — wave-level G1/G2: lint and build ONCE per wave, after every task in
 * the wave has settled, attributed to the wave rather than to any task.
 *
 * Correctness argument: tasks in a wave share one worktree, so a per-task
 * lint/build mid-wave measures peers' half-applied edits — a false `fail` that
 * burns retry-ladder budget. After the wave settles the tree is coherent, and
 * one run answers the question for every task in the wave at 1/N the cost.
 *
 * M8.1 interim (P0.2) — full-suite backstop: the resolved `test` command also
 * runs once per wave, after build. This closes the "zero tests ran" hole for
 * waves whose tasks declared no per-task test commands (G6 `no_command`):
 * without it, a wave can pass lint+build while every test in the repo is red.
 * A red suite fails the wave exactly like lint/build; `no_command` → ledger
 * and continue (existing wiring). Subsumed by the dedicated VERIFY full-suite
 * gate when M8 lands.
 *
 * A `fail` here fails the WAVE (the caller drains remaining waves); an
 * `unverifiable` is recorded in the ledger under the wave's pseudo-task id
 * (`W<n>`) and never blocks.
 */
export async function runWaveCommandGates(ctx: GateTaskContext): Promise<GateReport> {
  const runner = ctx.runner ?? defaultCommandRunner
  const startedAt = new Date().toISOString()
  const gates: GateResult[] = []

  for (const [name, kind] of [
    ['lint', 'lint'],
    ['build', 'build'],
    ['full-suite', 'test']
  ] as const) {
    gates.push(await gateCommand(name, kind, ctx, runner))
  }

  const report = buildGateReport(gates, { startedAt })
  gateLog.info(
    `[runWaveCommandGates] ${ctx.blueprintId}/wave-${ctx.taskId} → ${report.overall} ` +
      `(${gates.map((g) => `${g.name}:${g.verdict}`).join(' ')})`
  )
  return report
}

// ── VERIFY extensions (M8.2 / M8.3) ──

/**
 * M8.2 — VERIFY-phase command gates: the full suite as a backstop plus the
 * optional smoke command.
 *
 * Mirrors `runWaveCommandGates` but for the whole blueprint rather than one
 * wave. `gateCommand` already supplies the "missing ⇒ ledger, not failure"
 * semantics M8.2 requires: an unresolved smoke command returns
 * `unverifiable`/`no_command`, which the caller records in the ledger and
 * never treats as a fail. A red full-suite or red smoke IS a fail — backstop
 * parity with the wave level (M8.1).
 */
export async function runVerifyGates(ctx: GateTaskContext): Promise<GateReport> {
  const runner = ctx.runner ?? defaultCommandRunner
  const startedAt = new Date().toISOString()
  const gates: GateResult[] = []

  for (const [name, kind] of [
    ['full-suite', 'test'],
    ['smoke', 'smoke']
  ] as const) {
    gates.push(await gateCommand(name, kind, ctx, runner))
  }

  const report = buildGateReport(gates, { startedAt })
  gateLog.info(
    `[runVerifyGates] ${ctx.blueprintId}/verify → ${report.overall} ` +
      `(${gates.map((g) => `${g.name}:${g.verdict}`).join(' ')})`
  )
  return report
}

/** Hard budget for the structural gate's reindex — see `runStructuralGate`. */
export const STRUCTURAL_REINDEX_BUDGET_MS = 60_000

/** Cap on findings surfaced as evidence lines per category (bounded evidence). */
const STRUCTURAL_MAX_EVIDENCE_LINES = 20

/**
 * M8.3 — injectable collaborators for `runStructuralGate`, mirroring the
 * `CommandRunner` seam: tests supply fakes, production wires the real
 * code-graph service and git.
 */
export interface StructuralGateDeps {
  /** Reindex the workspace graph so it reflects post-build code. */
  indexWorkspace: (workspaceId: string, workspacePath: string) => Promise<void>
  /** Dead-code findings (file, line, name, …) for the indexed graph. */
  findDeadCode: (
    workspaceId: string,
    workspacePath: string,
    opts?: { path?: string; maxResults?: number; excludeSymbolKinds?: string[] }
  ) => Promise<Array<{ file: string; line: number; name: string; symbolKind: string | null }>>
  /** Import cycles, each an array of file paths forming the cycle. */
  findCircularDependencies: (
    workspaceId: string,
    opts?: { path?: string; maxCycles?: number }
  ) => string[][]
}

/**
 * M8.3 — structural analysis: NEW dead code and import cycles introduced by
 * the feature, scoped to the feature diff.
 *
 * Findings are WARNINGS, never fails (per the plan doc): the verdict is `pass`
 * with evidence lines naming each finding, or a clean `pass` when empty. Only
 * a graph that could not be built/queried is `unverifiable`/`analysis_unavailable`
 * → ledger.
 *
 * The graph must reflect post-build code or new dead code is invisible (a
 * stale index false-passes), so the reindex is AWAITED — but raced against a
 * 60s budget: a structural warning must never stall the terminal phase on a
 * huge workspace. Overrun or throw ⇒ `unverifiable`, honestly recorded.
 *
 * Scoping: findings are filtered to the feature's changed files (baseline =
 * `settingsJson.buildBaselineCommit` with merge-base fallback — the same
 * contract as lead-review's `assembleFeatureDiff`), so pre-existing debt in
 * untouched files cannot warn here.
 */
export async function runStructuralGate(
  ctx: GateTaskContext & {
    workspaceId: string
    /** Baseline commit for the feature diff; null ⇒ no_git. */
    baselineCommit: string | null
    /** Test seam — reindex budget override. Defaults to the 60s constant. */
    reindexBudgetMs?: number
  },
  deps: StructuralGateDeps
): Promise<GateResult> {
  const started = Date.now()
  const name: GateName = 'structural'

  if (!ctx.baselineCommit) {
    return unverifiable(
      name,
      'no_git',
      ['no feature baseline commit — changed-file scope could not be established'],
      Date.now() - started
    )
  }

  // Changed files from the feature diff. `git diff --name-only baseline..HEAD`;
  // a null result (not a repo, bad base) ⇒ unverifiable, never fail.
  const changed = await git(
    ['diff', '--name-only', `${ctx.baselineCommit}..HEAD`, '--'],
    ctx.executionPath,
    ctx.runner ?? defaultCommandRunner,
    ctx.signal
  )
  if (changed === null) {
    return unverifiable(
      name,
      'no_git',
      [`git diff --name-only ${ctx.baselineCommit}..HEAD failed`],
      Date.now() - started
    )
  }
  const changedSet = new Set(
    changed
      .split('\n')
      .map((l) => normalizePath(l.trim()))
      .filter(Boolean)
  )
  if (changedSet.size === 0) {
    return result(name, 'pass', ['feature diff is empty — nothing to analyze'], {
      durationMs: Date.now() - started
    })
  }

  // Budgeted reindex: race the await against the budget. The losing index
  // keeps running in the background (it will benefit the next consumer) but
  // this gate does not wait for it.
  const budgetMs = ctx.reindexBudgetMs ?? STRUCTURAL_REINDEX_BUDGET_MS
  try {
    await Promise.race([
      deps.indexWorkspace(ctx.workspaceId, ctx.executionPath),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`reindex exceeded ${budgetMs}ms budget`)), budgetMs)
      )
    ])
  } catch (err) {
    return unverifiable(
      name,
      'analysis_unavailable',
      [
        `code-graph reindex unavailable: ${
          err instanceof Error ? err.message : String(err)
        } — structural findings not assessed`
      ],
      Date.now() - started
    )
  }

  // Dead code, filtered to changed files.
  let dead: Array<{ file: string; line: number; name: string }> = []
  let cycles: string[][] = []
  try {
    const allDead = await deps.findDeadCode(ctx.workspaceId, ctx.executionPath)
    dead = allDead
      .filter((d) => changedSet.has(normalizePath(d.file)))
      .map((d) => ({ file: d.file, line: d.line, name: d.name }))

    // Import cycles touching changed files.
    const allCycles = deps.findCircularDependencies(ctx.workspaceId)
    cycles = allCycles.filter((cycle) => cycle.some((f) => changedSet.has(normalizePath(f))))
  } catch (err) {
    return unverifiable(
      name,
      'analysis_unavailable',
      [
        `code-graph query failed: ${
          err instanceof Error ? err.message : String(err)
        } — structural findings not assessed`
      ],
      Date.now() - started
    )
  }

  // Warnings, never fail: verdict stays `pass` with evidence naming findings.
  const evidence: string[] = []
  if (dead.length > 0) {
    evidence.push(
      ...dead
        .slice(0, STRUCTURAL_MAX_EVIDENCE_LINES)
        .map((d) => `new dead code: ${d.file}:${d.line} ${d.name}`)
    )
    if (dead.length > STRUCTURAL_MAX_EVIDENCE_LINES) {
      evidence.push(`…and ${dead.length - STRUCTURAL_MAX_EVIDENCE_LINES} more dead-code finding(s)`)
    }
  }
  if (cycles.length > 0) {
    evidence.push(
      ...cycles.slice(0, STRUCTURAL_MAX_EVIDENCE_LINES).map((c) => `import cycle: ${c.join(' → ')}`)
    )
    if (cycles.length > STRUCTURAL_MAX_EVIDENCE_LINES) {
      evidence.push(`…and ${cycles.length - STRUCTURAL_MAX_EVIDENCE_LINES} more cycle(s)`)
    }
  }

  if (evidence.length === 0) {
    return result(
      name,
      'pass',
      [`no new dead code or import cycles across ${changedSet.size} changed file(s)`],
      { durationMs: Date.now() - started }
    )
  }

  return result(name, 'pass', evidence, {
    counts: { deadCode: dead.length, cycles: cycles.length, changedFiles: changedSet.size },
    durationMs: Date.now() - started
  })
}

/**
 * Run every gate for one build task, cheapest first, stopping at the first
 * `fail`. Short-circuiting is not just a speed choice: running a 30-minute
 * build for a task that already wrote outside its write-set produces evidence
 * nobody will act on.
 */
export async function runGates(ctx: GateTaskContext, baseline: GateBaseline): Promise<GateReport> {
  const runner = ctx.runner ?? defaultCommandRunner
  const startedAt = new Date().toISOString()
  const gates: GateResult[] = []
  let shortCircuited = false

  const changes = await collectChanges(ctx, baseline, runner)

  const staticGates = [
    gateWriteSet(ctx, changes),
    gateStubScan(ctx, changes),
    gateTestIntegrity(ctx, baseline, changes)
  ]
  for (const gate of staticGates) {
    gates.push(gate)
    if (gate.verdict === 'fail') {
      shortCircuited = true
      break
    }
  }

  if (!shortCircuited && !ctx.skipCommandGates) {
    for (const [name, kind] of [
      ['lint', 'lint'],
      ['build', 'build']
    ] as const) {
      const gate = await gateCommand(name, kind, ctx, runner)
      gates.push(gate)
      if (gate.verdict === 'fail') {
        shortCircuited = true
        break
      }
    }
  }

  if (!shortCircuited) {
    gates.push(await gateTaskTests(ctx, baseline, runner))
  }

  const report = buildGateReport(gates, {
    startedAt,
    ...(shortCircuited ? { shortCircuited } : {})
  })
  gateLog.info(
    `[runGates] ${ctx.blueprintId}/${ctx.taskId} → ${report.overall} ` +
      `(${gates.map((g) => `${g.name}:${g.verdict}`).join(' ')})`
  )
  return report
}

/**
 * Mechanical fix instructions built from gate evidence (M4.1).
 *
 * Deliberately not prose: the retry prompt names the gate, the files and the
 * error tail, and nothing else. A weak builder handed an interpretation of a
 * failure will act on the interpretation; handed the failure, it fixes it.
 */
export function buildGateFixInstructions(report: GateReport): string {
  const failed = report.gates.filter((g) => g.verdict === 'fail')
  if (failed.length === 0) return ''

  const sections = failed.map((gate) => {
    const header = `### Gate: ${gate.name} — FAILED`
    const body = gate.evidence.map((line) => `- ${line}`).join('\n')
    const instruction = GATE_FIX_HINTS[gate.name] ?? 'Fix the cause reported above.'
    return `${header}\n\n${body}\n\n**Required:** ${instruction}`
  })

  return (
    'The previous attempt failed deterministic quality gates. ' +
    'These are machine-checked facts, not opinions — fix exactly what is listed.\n\n' +
    sections.join('\n\n')
  )
}

const GATE_FIX_HINTS: Partial<Record<GateName, string>> = {
  'write-set':
    'Revert every change to the files listed above. They are outside this task’s write-set. If the task genuinely cannot be done without them, say so instead of editing them.',
  'stub-scan':
    'Replace each marker above with a real implementation. Do not delete the line — implement it.',
  'test-integrity':
    'Restore the listed test files to their original content and re-enable every disabled test. The tests are the specification; make the code satisfy them.',
  lint: 'Fix the reported lint errors. Do not disable the rules.',
  build: 'Fix the reported compile/type errors.',
  'task-tests':
    'Make the listed tests pass by changing the implementation. Editing the tests is checked separately and will fail the task.'
}
