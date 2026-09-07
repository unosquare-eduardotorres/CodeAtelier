/**
 * Deterministic quality gates — kernel-owned, run in the MAIN process after a
 * build-task session ends. The graded agent never runs its own gates.
 *
 * Execution order is cheapest-first with a short-circuit on `fail`, so a task
 * that wrote outside its write-set never pays for a 30-minute build:
 *
 *   G4 write-set → G3 stub scan → G5 test integrity → G4b destructive-revert
 *     → G2 lint → G1 build → G6 task tests
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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
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
import { rewriteVenvInterpreter } from '../../shared/gate-command-rewrite'
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

import { buildGateEnv } from './env-utils'

const gateLog = log.scope('blueprint-gates')

/** Per-file read cap for hashing and stub scanning. Beyond this, skip. */
const MAX_SCAN_BYTES = 1_000_000

/** How many paths any human- or model-facing list names before it says “+N more”. */
export const MAX_LISTED_PATHS = 25

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
        // Gate commands run against a TARGET repo: they must not inherit this
        // app's build mode (NODE_ENV), npm lifecycle state, or vitest worker
        // identity — see buildGateEnv for the incidents that motivated this.
        env: buildGateEnv()
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
   * Which command gates this task's ladder runs. `undefined` = lint + build
   * (the standalone/legacy default).
   *
   * R3.3 moved BOTH to wave level, on the reasoning that a per-task lint/build
   * in a shared worktree measures peers' mid-flight edits. P2a keeps that for
   * `lint` and reverses it for `build`: in DAG mode gates fire only at drain
   * points, and a well-connected graph has exactly ONE — so a broken import
   * landed at 14:42 and surfaced at 15:03, after four more tasks had built on
   * it. Measured on the same run, typecheck is 3,751 ms against a mean task
   * time of 285 s (~1 %), while lint is 13,991 ms and the full suite 77,127 ms.
   * The build service therefore passes `['build']`; `[]` skips both.
   *
   * **Accepted risk:** R3.3's objection still applies to `build` — a per-task
   * typecheck in a shared worktree can see a peer's half-applied edit and fail
   * this task for it, costing a retry. Taken deliberately: on the run that
   * motivated this, a broken import survived 21 minutes and four dependent
   * tasks because nothing compiled anything until the single drain point. A
   * false fail costs one retry; a poisoned tree cost the whole build.
   */
  commandGates?: readonly Extract<GateName, 'lint' | 'build'>[]
  /**
   * R1.2 — parallel-wave attribution: files declared by OTHER tasks currently
   * in flight in the same worktree. Their changes are visible in this task's
   * diff but are not this task's work, so `collectChanges` subtracts them
   * exactly as it subtracts `preexistingDirty`. Supplied by the wave scheduler
   * at gate time; absent for serial/legacy callers (empty = no exemption).
   */
  exemptFiles?: readonly string[]
  /**
   * F1 (step 2) — paths THIS task's own write tools targeted, accumulated across
   * every attempt from the `file_path` argument of each write-capable tool_use.
   *
   * This is the only signal that can tell "a peer wrote its own file" from "I
   * wrote into a peer's file": the diff shows both as the same bytes, so
   * `exemptFiles` alone forces the honest-but-weak `unverifiable` verdict. A
   * path listed here is attributable to this task no matter who DECLARES it, so
   * the peer exemption does not apply to it and a write outside the write-set
   * fails, as it would for any other path.
   *
   * Absolute (the CLI backends emit absolute `file_path`) or repo-relative;
   * both forms are re-rooted onto `executionPath` before use. Absent for
   * callers with no executor instrumentation — the gate then degrades to the
   * `unverifiable` verdict rather than to a false pass.
   */
  writtenPaths?: readonly string[]
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

/**
 * A packet test file as the baseline captured it — the hash/count the gate
 * judges against, plus the BYTES needed to put it back.
 *
 * The content is kept because the gate is the only thing that knows what the
 * spec looked like before the session, and a failed attempt leaves its edit on
 * disk: without the bytes, every later attempt is graded on the first one's
 * damage and the failure can never clear (see `restorePacketTestFiles`).
 * Bounded by `MAX_SCAN_BYTES` per file and by the packet's own test list.
 */
interface CapturedTestFile extends TestFileState {
  content: string
}

export interface GateBaseline {
  /** Commit the task started from — the diff base. */
  baselineCommit: string | null
  /** Files already dirty before the task began; their changes are not this task's. */
  preexistingDirty: string[]
  /** Packet test files as they were before the session, with their content. */
  testsBefore: Record<string, CapturedTestFile>
  /** Whether the packet's tests were red before the session (the red proof). */
  redProof: 'red' | 'green' | 'unavailable'
  redEvidence: string[]
  /**
   * P2a — the `build` command's diagnostics BEFORE the task ran.
   *
   * `task-tests` has had a red proof since M2: a suite that was already green
   * proves nothing. The `build` gate had no equivalent, and it runs a
   * WORKSPACE-WIDE command — so on a tree that is broken on arrival (a recovery
   * run, or damage another task did) every task fails a typecheck for errors it
   * did not introduce, burns its whole ladder and escalates. Live: T002 and T003
   * failed 4 attempts each on a missing export belonging to T008.
   *
   * Absent when no build command resolved, when the ladder is not running the
   * build gate, or when the command could not be spawned — in all three the gate
   * keeps its previous behaviour rather than discounting anything.
   */
  buildBefore?: { failed: boolean; signatures: string[] }
}

function hashFile(absPath: string): CapturedTestFile | null {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null
    const content = readFileSync(absPath, 'utf-8')
    return {
      hash: createHash('sha256').update(content).digest('hex'),
      testCount: countTests(content),
      content
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
 * `resolveInside`, hardened for the WRITE path.
 *
 * The lexical bound is enough to READ safely, but a packet test file that is a
 * SYMLINK out of the tree resolves lexically inside and a write through it
 * lands outside the workspace. Only the restore writes, so only the restore
 * pays for the extra `realpath`. When nothing on the path exists yet (the
 * attempt deleted the file along with its directory) there is no link to
 * follow and the lexical bound is the whole answer.
 */
function resolveInsideForWrite(root: string, candidate: string): string | null {
  const abs = resolveInside(root, candidate)
  if (!abs) return null
  try {
    const realRoot = realpathSync(root)
    // A missing file would be created inside its parent, so that is what has to
    // be inside the tree.
    const realTarget = existsSync(abs) ? realpathSync(abs) : realpathSync(dirname(abs))
    const rel = relative(realRoot, realTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
  } catch {
    // Neither the file nor its parent resolves — nothing to follow, and the
    // lexical bound above already held.
  }
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

  const testsBefore: Record<string, CapturedTestFile> = {}
  for (const rel of ctx.packet?.testFiles ?? []) {
    const abs = resolveInside(cwd, rel)
    if (!abs) continue
    const state = hashFile(abs)
    if (state) testsBefore[normalizePath(rel)] = state
  }

  const { redProof, redEvidence } = await captureRedProof(ctx, runner)
  const buildBefore = await captureBuildBaseline(ctx, runner)

  return {
    baselineCommit: head?.trim().split('\n')[0] ?? null,
    preexistingDirty,
    testsBefore,
    redProof,
    redEvidence,
    ...(buildBefore ? { buildBefore } : {})
  }
}

/**
 * Put packet test files back exactly as the baseline captured them.
 *
 * The gate grades the working tree against a baseline captured ONCE, before
 * attempt 1, and nothing in the ladder reverts the tree between attempts. So
 * the moment one attempt edits a pre-authored test file, that edit is permanent
 * for the rest of the ladder: attempt 2 can be flawless and still be told `test
 * file modified`, which fingerprints identically to attempt 1, trips the B3
 * stop-loss, and escalates to a lead model that inherits the same unfixable
 * failure. Observed as three attempts producing byte-identical evidence.
 *
 * Asking the builder to revert it does not work: `REVERT_SCOPE_RULE` forbids
 * rolling back a file it does not own, and a pre-authored test is precisely the
 * kind of file it reads as somebody else's. So the kernel does it — free,
 * deterministic, and it writes the captured BYTES rather than the model's
 * reconstruction of them.
 *
 * Bounded three times: only files the baseline captured (i.e. declared in the
 * packet's `testFiles`), only paths that resolve inside `executionPath`, and
 * never a path a PEER task declares (`ctx.exemptFiles`). The peer bound is the
 * one that matters most: this is the kernel doing, unprompted, exactly what
 * `REVERT_SCOPE_RULE` forbids the builder from doing — writing over a file it
 * does not own — and in a parallel wave the divergence it is "repairing" may be
 * a peer's uncommitted, in-flight work.
 *
 * A file already matching the baseline is left alone and not reported, and a
 * write that does not read back as the captured hash is reported as NOT
 * restored — a short write, a full disk or a concurrent writer would otherwise
 * be announced to the builder as "back to the specification" while differing
 * from it, and the next gate failure would be unexplainable.
 *
 * **Accepted risk:** a human editing a packet test file while the task runs is
 * indistinguishable from the builder doing it, and is overwritten. Nothing in
 * the tree records authorship of an uncommitted edit, so this cannot be bounded
 * away — it is the price of the guarantee that a failed attempt never leaves a
 * weakened spec behind.
 */
export function restorePacketTestFiles(
  ctx: GateTaskContext,
  baseline: GateBaseline,
  files: readonly string[]
): string[] {
  const peerOwned = new Set((ctx.exemptFiles ?? []).map(normalizePath))
  const restored: string[] = []
  for (const rel of Array.from(new Set(files.map((f) => normalizePath(f))))) {
    const before = baseline.testsBefore[rel]
    // Not a packet test file the baseline captured — never ours to write.
    if (!before) continue
    // Declared by another in-flight task too. Its edit is its work, and
    // pre-session bytes would destroy it mid-session.
    if (peerOwned.has(rel)) {
      gateLog.warn(
        `[gates] ${ctx.taskId}: NOT restoring ${rel} — a peer task declares it, so the ` +
          `divergence may be that peer's in-flight work`
      )
      continue
    }
    const abs = resolveInsideForWrite(ctx.executionPath, rel)
    if (!abs) continue
    try {
      if (existsSync(abs) && hashFile(abs)?.hash === before.hash) continue
      // The parent may be gone when the attempt deleted the file with its dir.
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, before.content, 'utf-8')
      // Read back. `writeFileSync` reports no error on a short write, and
      // nothing stops another writer touching the file in between. Claiming a
      // restore that did not happen is worse than reporting none — the next
      // gate would then fail against a file the log says is back to spec.
      if (hashFile(abs)?.hash !== before.hash) {
        gateLog.warn(
          `[gates] ${ctx.taskId}: restore of ${rel} did not round-trip to the captured ` +
            `bytes — reporting it as NOT restored`
        )
        continue
      }
      restored.push(rel)
    } catch (err) {
      gateLog.warn(`[gates] Could not restore packet test file ${rel}:`, err)
    }
  }
  return restored
}

/**
 * Packet test files that are WEAKER on disk than the baseline captured them.
 *
 * The report-driven restore is precise but only fires where a `test-integrity`
 * verdict exists — and the ladder has exits that produce none: a gate that
 * short-circuits on `write-set` or `stub-scan` discards the computed
 * `test-integrity` result, and a session that fails outright (or is aborted) is
 * never graded at all. Those exits used to end with the weakened spec on disk,
 * where the operator's next Retry captures it as the NEW baseline and every
 * gate goes green over a neutered test.
 *
 * So this is the net: hash and test-count only, no diff, no git, no commands.
 * It reports a file only when the content differs AND the test count did not
 * increase — a strict increase is the EXTENSION ALLOWANCE the gate itself
 * grants, and authoring must never be swept away. Peer-declared and
 * unreadable files are skipped for the same reasons the restore skips them.
 */
export function divergedPacketTestFiles(ctx: GateTaskContext, baseline: GateBaseline): string[] {
  const peerOwned = new Set((ctx.exemptFiles ?? []).map(normalizePath))
  const diverged: string[] = []
  for (const [rel, before] of Object.entries(baseline.testsBefore)) {
    if (peerOwned.has(rel)) continue
    const abs = resolveInside(ctx.executionPath, rel)
    if (!abs) continue
    if (!existsSync(abs)) {
      diverged.push(rel)
      continue
    }
    const now = hashFile(abs)
    // Unreadable or grown past the scan cap: not something to judge, and
    // certainly not something to overwrite on a guess.
    if (!now) continue
    if (now.hash === before.hash) continue
    if (now.testCount > before.testCount) continue
    diverged.push(rel)
  }
  return diverged
}

/**
 * Lines that carry a source position — `file.ts(12,7)` (tsc) or `file.ts:12:7`
 * (eslint, gcc, most others). Summary lines ("Found 3 errors in 2 files") carry
 * none, which is what keeps a changing error COUNT from reading as a new error.
 */
const DIAGNOSTIC_LINE = /\(\d+,\d+\)|:\d+:\d+/

/**
 * F11 (1.3) — neutralise a failed attempt's out-of-set writes before the next
 * attempt dispatches.
 *
 * THE BUG THIS CLOSES (live: T014): the gate baseline is captured once before
 * attempt 1 and never advances, so a failed attempt's out-of-set edits stay in
 * the worktree and every later attempt is charged for them — forever. A rung
 * that died on `api_error` with `writes=0 bash=0` failed `write-set` on a file
 * it never touched: the violation was attempt 1's, still on disk. The manual
 * Retry button "fixes" the task only because a fresh run re-captures the
 * baseline and absorbs the leftovers as pre-existing. This sweep is that
 * insight applied to the automatic path: revert what the gate PROVED this
 * task wrote outside its set, so attempt N+1 starts from the tree attempt N
 * was graded against, minus attempt N's condemnable edits.
 *
 * Bounds, in order:
 *   - only paths named by the failed write-set gate's `files` array (the
 *     gate already excluded peer-owned, pre-existing and bookkeeping paths);
 *   - `ctx.exemptFiles` is re-checked here anyway — the exemption set is
 *     refreshed per attempt and a peer may have DECLARED the path since the
 *     gate ran (its in-flight work must never be swept);
 *   - inside the execution path, symlink-hardened (`resolveInsideForWrite`);
 *   - tracked at `baseline.baselineCommit` → `git checkout <commit> -- <path>`;
 *     untracked at baseline → deleted (the file did not exist when the task
 *     started);
 *   - no baseline commit → the sweep degrades to a no-op (never a blind
 *     delete on a tree git cannot describe).
 *
 * Never throws: runs in the ladder's `finally`, where a sweep failure must not
 * replace the failure it is cleaning up after.
 */
export interface SweepOutcome {
  /** The paths actually reverted (what the old string return carried). */
  reverted: string[]
  /**
   * B4 — absolute path of the patch preserving the reverted hunks, when the
   * capture succeeded. `git apply <patch>` restores them verbatim, so the
   * sweep is reversible. Written BEFORE any revert, so a failure midway
   * still leaves a complete record of everything the sweep was about to
   * destroy (and everything it already had).
   */
  patchPath?: string
}

export async function sweepOutOfWorksetWrites(
  ctx: GateTaskContext,
  baseline: GateBaseline,
  violations: readonly string[],
  signal?: AbortSignal
): Promise<SweepOutcome> {
  // The default runner spawns through `shell: true`, so a path containing a
  // space would split into two argv entries and checkout the wrong tree
  // object. POSIX single-quote, with the embedded-quote escape.
  const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const reverted: string[] = []
  if (violations.length === 0) return { reverted }
  const commit = baseline.baselineCommit
  if (!commit) {
    gateLog.warn(`[gates] ${ctx.taskId}: retry cleanup skipped — no baseline commit to revert to`)
    return { reverted }
  }
  const peerOwned = new Set((ctx.exemptFiles ?? []).map(normalizePath))

  // B4 — preserve what this sweep is about to revert, before reverting it.
  // Motivated by a live run where the out-of-set "violation" was the ONLY
  // copy of a correct fix (a client component pulling `pg`/`nodemailer` into
  // the browser bundle), and reverting it would have destroyed the work
  // outright. The capture is bounded by the same `violations` array the
  // revert loop walks, so the patch is exactly the sweep's blast radius:
  // `git diff -- <paths>` for tracked content, plus the full bytes of any
  // path untracked at HEAD (the revert loop would `rm` those — a diff
  // against HEAD does not contain them). Best-effort: a capture failure
  // degrades to today's behaviour (revert with no patch) rather than
  // skipping the sweep, but it is logged loudly.
  const patchPath = await captureSweepPatch(ctx, commit, violations, signal)

  for (const raw of violations) {
    const rel = normalizePath(raw)
    if (peerOwned.has(rel)) {
      gateLog.warn(
        `[gates] ${ctx.taskId}: retry cleanup NOT reverting ${rel} — a peer task now declares it`
      )
      continue
    }
    const abs = resolveInsideForWrite(ctx.executionPath, rel)
    if (!abs) continue
    try {
      if (!existsSync(abs)) continue // already gone — nothing to revert
      // Tracked at the baseline commit? The probe runs on the raw runner (not
      // the `git()` helper) because the two failure modes must stay distinct:
      // exit 1 = path absent from that tree (untracked at baseline → delete);
      // spawn error = git itself broken (→ skip — a blind delete would remove
      // a TRACKED file on a machine whose git is unusable).
      const probe = await defaultCommandRunner(
        `git cat-file -e ${shellQuote(`${commit}:${rel}`)}`,
        { cwd: ctx.executionPath, timeoutMs: GIT_TIMEOUT_MS, signal, captureFull: true }
      )
      if (probe.spawnError) {
        gateLog.warn(
          `[gates] ${ctx.taskId}: retry cleanup probe failed for ${rel} — skipping (git unusable)`
        )
        continue
      }
      if (probe.exitCode === 0) {
        // Routed through `git()` (captureFull, `--` before the path) but with
        // the path quoted for the same shell reason as the probe.
        const outcome = await git(
          ['checkout', commit, '--', shellQuote(rel)],
          ctx.executionPath,
          defaultCommandRunner,
          signal
        )
        if (outcome !== null) reverted.push(rel)
        else gateLog.warn(`[gates] ${ctx.taskId}: retry cleanup checkout failed for ${rel}`)
      } else {
        rmSync(abs, { force: true })
        reverted.push(rel)
      }
    } catch (err) {
      gateLog.warn(`[gates] ${ctx.taskId}: retry cleanup failed for ${rel}:`, err)
    }
  }
  return { reverted, ...(patchPath ? { patchPath } : {}) }
}

/**
 * B4 — the patch capture half of {@link sweepOutOfWorksetWrites}.
 *
 * Writes `<artifactPrefix>/retry-cleanup-<taskId>-<attempt-token>.patch`
 * inside the blueprint's own artifact directory (the same prefix the
 * write-set gate already exempts as app bookkeeping), so the patch can
 * never itself become an out-of-set write. Returns undefined on any
 * failure — the sweep must never refuse to run because its historian
 * could not take notes.
 */
async function captureSweepPatch(
  ctx: GateTaskContext,
  commit: string,
  violations: readonly string[],
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    // Paths that exist on disk but not at the baseline commit — the sweep's
    // `rm` branch. Only these need their bytes embedded; tracked paths are
    // fully described by `git diff -- <paths>`.
    const untrackedBytes: string[] = []
    for (const raw of violations) {
      const rel = normalizePath(raw)
      const abs = resolveInsideForWrite(ctx.executionPath, rel)
      if (!abs || !existsSync(abs)) continue
      const probe = await defaultCommandRunner(
        `git cat-file -e ${shellQuote(`${commit}:${rel}`)}`,
        { cwd: ctx.executionPath, timeoutMs: GIT_TIMEOUT_MS, signal, captureFull: true }
      )
      if (probe.spawnError) continue // git unusable — diff below will fail too
      if (probe.exitCode !== 0) {
        const bytes = readFileSync(abs)
        if (bytes.length <= MAX_CAPTURE_BYTES) {
          // `git apply`-shaped new-file hunk: without the `diff --git` + `new
          // file mode` header the section is prose, and a combined patch
          // that is half-parseable applies NEITHER half.
          const lines = bytes.toString('utf8').split('\n')
          // A trailing newline makes the last element '' — git hunk counts
          // exclude that phantom line.
          const contentLines = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
          untrackedBytes.push(
            `diff --git a/${rel} b/${rel}\n` +
              `new file mode 100644\n` +
              `--- /dev/null\n` +
              `+++ b/${rel}\n` +
              `@@ -0,0 +1,${contentLines.length} @@\n` +
              contentLines.map((l) => `+${l}`).join('\n')
          )
        }
      }
    }
    const quoted = violations.map((v) => shellQuote(normalizePath(v))).join(' ')
    // Against the BASELINE commit, not HEAD: the revert below is
    // `git checkout <commit> -- <path>`, so the patch must describe the same
    // delta (worktree vs that commit) or re-applying it would not restore
    // what the sweep destroyed. A plain `git diff` would also miss staged
    // changes; diffing against the commit covers index and worktree both.
    const diff = await defaultCommandRunner(`git diff ${shellQuote(commit)} -- ${quoted}`, {
      cwd: ctx.executionPath,
      timeoutMs: GIT_TIMEOUT_MS,
      signal,
      captureFull: true
    })
    if (diff.spawnError && untrackedBytes.length === 0) return undefined
    // Each section carries exactly ONE trailing newline: git apply rejects a
    // blank line between file sections ("corrupt patch"), and the runner's
    // split/rejoin can leave the tracked diff ending in '' — which joins back
    // to a trailing newline already. Normalise, then concatenate directly.
    const endWithNewline = (s: string): string => (s.endsWith('\n') ? s : s + '\n')
    const trackedBody =
      diff.exitCode === 0 && diff.output.length > 0 ? endWithNewline(diff.output.join('\n')) : ''
    const body = trackedBody + untrackedBytes.map(endWithNewline).join('')
    if (!body.trim()) return undefined // nothing diverged — nothing to preserve

    const dir = ctx.artifactPrefix ? join(ctx.executionPath, ctx.artifactPrefix) : ctx.executionPath
    mkdirSync(dir, { recursive: true })
    const token = `${ctx.taskId}-${Date.now()}`
    const patchPath = join(dir, `retry-cleanup-${token}.patch`)
    writeFileSync(patchPath, body, 'utf8')
    gateLog.info(
      `[gates] ${ctx.taskId}: retry cleanup preserved ${violations.length} path(s) → ${patchPath}`
    )
    return patchPath
  } catch (err) {
    gateLog.warn(`[gates] ${ctx.taskId}: retry cleanup patch capture failed:`, err)
    return undefined
  }
}

/**
 * Position-independent signatures of the diagnostics in a command's output.
 *
 * Line and column numbers are normalised away: editing a file shifts every
 * diagnostic below the edit, and a shifted error is the SAME error. The file
 * path and the message are kept, because those are what make two diagnostics
 * different.
 */
function diagnosticSignatures(output: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const line of output) {
    if (!DIAGNOSTIC_LINE.test(line)) continue
    out.add(
      line
        .replace(/\(\d+,\d+\)/g, '(#,#)')
        .replace(/:\d+:\d+/g, ':#:#')
        .replace(/\s+/g, ' ')
        .trim()
    )
  }
  return out
}

/**
 * P2a — run the `build` command BEFORE the task, so its gate can tell errors
 * this task introduced from errors it inherited.
 *
 * Paid once per task (at baseline capture), not once per attempt. Measured at
 * 3,751 ms against a mean task time of 285 s, so the second run costs ~1 % on
 * top of the gate's own.
 */
async function captureBuildBaseline(
  ctx: GateTaskContext,
  runner: CommandRunner
): Promise<GateBaseline['buildBefore']> {
  const gates = ctx.commandGates ?? (['lint', 'build'] as const)
  if (!gates.includes('build')) return undefined
  const command = ctx.commands.build
  if (!command) return undefined

  const outcome = await withWorktreeLock(ctx.executionPath, () =>
    runner(command.command, {
      cwd: commandCwd(ctx, command),
      timeoutMs: GATE_TIMEOUTS_MS.build,
      signal: ctx.signal
    })
  )
  // A spawn failure or timeout says nothing about the tree's health. Returning
  // `undefined` leaves the gate exactly as it behaved before this existed.
  if (outcome.spawnError || outcome.timedOut) return undefined

  return {
    failed: outcome.exitCode !== 0,
    signatures: [...diagnosticSignatures(outcome.output)]
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
/**
 * Paths that look like tests, across the ecosystems the gate stack supports.
 *
 * Deliberately conservative: it decides whether a path THIS task already
 * declared may be handed to the detected runner, so a false positive costs a
 * spawn error and a false negative costs only the honest `no_command`.
 */
function looksLikeTestFile(path: string): boolean {
  const p = normalizePath(path)
  return (
    /(^|\/)(__tests__|tests?)\//.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)test_[^/]+\.py$/.test(p) ||
    /_test\.(go|py|rb)$/.test(p) ||
    /[Tt]ests?\.cs$/.test(p)
  )
}

/**
 * The test files this task can be graded on, best source first.
 *
 * P2b — the packet's `testFiles` is the declared contract and always wins. The
 * fallback is the task's OWN declared write-set filtered to test-looking paths:
 * on a real 15-task run `task-tests` was `unverifiable`/`no_command` on 100 %
 * of tasks because no packet carried `testFiles`, so the per-task test gate had
 * never once executed. Nothing is invented here — every candidate is a path the
 * task itself declared it would touch.
 */
function taskTestFiles(ctx: GateTaskContext): string[] {
  const declared = (ctx.packet?.testFiles ?? []).filter((f) => typeof f === 'string' && f.trim())
  if (declared.length > 0) return declared
  return ctx.plannedFiles.filter((f) => typeof f === 'string' && looksLikeTestFile(f))
}

function taskTestCommand(ctx: GateTaskContext): ResolvedGateCommand | undefined {
  // Defence-in-depth (same shape as the parser's parse-time drop): a packet
  // `testCommand` is honoured ONLY alongside `testFiles`. The packet's file
  // list is the declared contract for what this task may be graded on, and a
  // command broader than that contract — observed in the wild: a 2-file CI
  // task whose packet declared the whole Docker + Playwright portal suite —
  // grades the task on the entire system, including defects outside its
  // write-set. Packets that bypassed the parser (or predate the parse-time
  // drop) are caught here; `gateTaskTests` then reports `unverifiable` /
  // `no_command`, which is the honest verdict for a task with no tests of
  // its own.
  const testFiles = taskTestFiles(ctx)

  if (testFiles.length === 0) return undefined

  const packetCommand = ctx.packet?.testCommand?.trim()
  if (packetCommand) {
    if (!isSafeGateCommand(packetCommand)) {
      gateLog.warn(
        `[taskTestCommand] packet testCommand for ${ctx.taskId} failed the safety guard — treating as absent`
      )
      return undefined
    }
    // T003/G2 — the packet command runs with cwd = worktree, where a
    // gitignored venv never exists. Same rewrite the cache-level resolution
    // applies: rebind the venv interpreter token to the SOURCE checkout, which
    // is valid from any cwd because a venv python resolves site-packages from
    // its own home, never cwd. Without this, packet-declared commands were the
    // ONE resolution path the rewrite never touched (G6 graded them red
    // forever; the pre-dispatch check never saw them at all).
    const r = rewriteVenvInterpreter(packetCommand, {
      sourceRoot: ctx.workspacePath,
      worktreeRoot: ctx.executionPath
    })
    return { command: r.command, provenance: 'declared' }
  }

  // R3.1 — ecosystem template (M2.6 Option 2): when the packet declares test
  // FILES but no command, build a narrow per-task command from the detected
  // toolchain. The full suite is never used here — that is VERIFY's job (M8).
  if (testFiles.length) {
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

/**
 * T003/G2+G6 — the effective per-task test command, WITHOUT running it.
 *
 * The single source the pre-dispatch prerequisite check
 * (`checkTaskInterpreterPrerequisite`) and the G6 gate (`gateTaskTests` →
 * `taskTestCommand`) both derive from: the PACKET `testCommand` (post-venv-
 * rewrite) when the packet declares `testFiles`, else the resolved
 * workspace-level `commands.test`. Before this helper the two sites read
 * different sources — the prerequisite check read only `commands.test`, so a
 * packet-declared venv command that was missing on disk dispatched a doomed
 * builder rung the gate then graded as an environmental `command_missing`,
 * forever. Both sites now consume this, so they cannot diverge again.
 */
export function effectiveTaskTestCommand(ctx: GateTaskContext): ResolvedGateCommand | undefined {
  return taskTestCommand(ctx) ?? (ctx.commands.test ? { ...ctx.commands.test } : undefined)
}

function commandCwd(ctx: GateTaskContext, command: ResolvedGateCommand): string {
  return command.cwd ? join(ctx.executionPath, command.cwd) : ctx.executionPath
}

// ── Gate result helpers ──

function result(
  name: GateName,
  verdict: GateVerdict,
  evidence: string[],
  extra?: {
    reason?: UnverifiableReason
    counts?: Record<string, number>
    files?: string[]
    durationMs?: number
  }
): GateResult {
  return {
    name,
    verdict,
    evidence: boundEvidence(evidence),
    ...(extra?.reason ? { reason: extra.reason } : {}),
    ...(extra?.counts ? { counts: extra.counts } : {}),
    ...(extra?.files?.length ? { files: extra.files } : {}),
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
/**
 * T003/G4 — POSIX "the interpreter PATH is absent" signatures. These are
 * SHELL-SHAPED lines (`sh: 1: .venv/bin/python: not found`), not bare
 * substrings: `python: can't open file 'tests/x.py': [Errno 2] No such file
 * or directory` is a RED suite (the interpreter ran; the test file it was
 * pointed at is missing) and must stay `fail`. A bare substring match graded
 * that red suite as `command_missing` and failed open.
 */
const POSIX_MISSING_PATH_RE =
  /^(\/.*\/)?(sh|bash|zsh|dash|ksh)((:? )?\d+)?: [^:]+: (no such file or directory|not found)/i

const MISSING_COMMAND_SIGNATURES = [
  'is not recognized as', // cmd.exe / PowerShell
  'command not found', // sh / bash / zsh
  'no module named', // `python -m <runner>` with the runner absent
  // T003 loop fix — the interpreter PATH is absent, not a PATH lookup. With
  // `shell: true` these are exit-1 outputs, not spawnErrors, so without these
  // signatures a venv-python declared in TASKS but missing from the worktree
  // (gitignored, never provisioned) graded as a plain `fail` and fed the retry
  // ladder forever — nothing a builder attempt could change.
  'the system cannot find the path specified' // cmd.exe — absent interpreter PATH (unambiguous)
] as const

/** True when the output shows the command's binary was never executed. */
function isCommandMissing(output: readonly string[]): boolean {
  // Only the first two lines are scanned: every shell prints its "not found"
  // signature as the FIRST line of output, before any runner header. A red
  // suite's assertion text can legitimately quote those strings (a test
  // asserting on subprocess error text) — that appears AFTER the header, and
  // matching it would flip a real regression to `unverifiable`, failing open.
  return output.slice(0, 2).some((line) => {
    const lower = line.toLowerCase()
    return (
      MISSING_COMMAND_SIGNATURES.some((sig) => lower.includes(sig)) ||
      POSIX_MISSING_PATH_RE.test(line)
    )
  })
}

// ── Change collection ──

/** Why a changed path was not attributed to the graded task. */
type ExemptionReason = 'preexisting' | 'peer' | 'bookkeeping'

/**
 * Buckets on `ChangeSet.exempted`. `peerChanged` is NOT a filter reason — no
 * path is dropped because of it. It records which peer-exempt paths actually
 * differ from the baseline, which the three reasons above cannot express.
 */
type ChangeBucket = ExemptionReason | 'peerChanged'

const emptyBuckets = (): Record<ChangeBucket, string[]> => ({
  preexisting: [],
  peer: [],
  bookkeeping: [],
  peerChanged: []
})

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
  exempted: Record<ChangeBucket, string[]>
  /**
   * F1 — peer-exempt paths that CHANGED since the baseline and that no commit
   * in `baseline..HEAD` explains. Nobody we can name produced them, so no
   * verdict about this task's write-set can be supported while they are in the
   * tree: `gateWriteSet` reports `unverifiable`, never a pass and never a fail.
   */
  peerUnattributed: string[]
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
  if (!baseline.baselineCommit) {
    return {
      files: [],
      addedLines: [],
      unavailable: 'no git baseline commit',
      exempted: emptyBuckets(),
      peerUnattributed: []
    }
  }

  const diff = await git(
    ['diff', '-U0', '--no-color', baseline.baselineCommit, '--'],
    cwd,
    runner,
    ctx.signal
  )
  if (diff === null) {
    return {
      files: [],
      addedLines: [],
      unavailable: 'git diff failed',
      exempted: emptyBuckets(),
      peerUnattributed: []
    }
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
  // F1 (step 2) — a path this task's own write tools targeted is THIS task's
  // change, whoever declares it. Subtracting it from the exempt set before any
  // other rule means the write-set gate reports it as the violation it is,
  // instead of dropping it and reporting `pass`.
  const writtenByThisTask = writtenPathSet(ctx)
  const peerDeclared = new Set((ctx.exemptFiles ?? []).map(normalizePath))
  const exemptExact = new Set([...peerDeclared].filter((f) => !writtenByThisTask.has(f)))
  const bookkeepingPrefixes = ctx.artifactPrefix
    ? [...APP_BOOKKEEPING_PREFIXES, normalizePath(ctx.artifactPrefix)]
    : APP_BOOKKEEPING_PREFIXES

  const exempted = emptyBuckets()
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

  // F1 — the set of paths that DIFFER from the baseline, by name. `files` above
  // cannot answer that question: it is built from added lines and untracked
  // files, so a pure DELETION appears nowhere in it — and a 69-line deletion out
  // of a peer's spec is exactly the change that started this.
  const changedNames =
    peerDeclared.size > 0
      ? await changedNameSet(ctx, cwd, runner, baseline.baselineCommit, untracked)
      : new Set<string>()

  if (changedNames) {
    // A peer's file that THIS task's write tools targeted, and that really did
    // change, belongs in this task's diff however it changed. Without this a
    // deletion-only write into a peer's file would leave `files` untouched and
    // the gate would pass it — the very hole step 2 exists to close.
    for (const name of changedNames) {
      if (!writtenByThisTask.has(name) || !peerDeclared.has(name)) continue
      if (notThisTasks(name) || files.includes(name)) continue
      files.push(name)
    }
  }

  const peerUnattributed = await findPeerUnattributed({
    ctx,
    cwd,
    runner,
    baselineCommit: baseline.baselineCommit,
    exemptExact,
    dirtyBefore,
    changedNames,
    peerChanged: exempted.peerChanged
  })

  return { files, addedLines, exempted, peerUnattributed }
}

/**
 * Paths that differ from the baseline commit, by NAME — deletions included.
 *
 * `null` when git could not answer. Callers treat that as "cannot attribute",
 * never as "nothing changed": the whole diff already succeeded by this point, so
 * a failure here is a genuine unknown rather than a clean tree.
 */
async function changedNameSet(
  ctx: GateTaskContext,
  cwd: string,
  runner: CommandRunner,
  baselineCommit: string,
  untracked: readonly string[]
): Promise<Set<string> | null> {
  const named = await git(
    ['diff', '--name-only', '-z', baselineCommit, '--'],
    cwd,
    runner,
    ctx.signal
  )
  if (named === null) return null
  return new Set([...splitNulPaths(named), ...untracked])
}

/**
 * `ctx.writtenPaths` as repo-relative, normalized paths.
 *
 * The write tools report `file_path` absolutely on the CLI backends. A path is
 * re-rooted onto the execution root first and onto the primary checkout second
 * (planned paths are recorded against the primary checkout even when the task
 * runs in a worktree — the same re-rooting `verifyBuildTaskFiles` does). One
 * that escapes both roots is dropped: it cannot be compared with a diff path,
 * and a mis-rooted entry would remove a legitimate peer exemption.
 */
function writtenPathSet(ctx: GateTaskContext): Set<string> {
  const out = new Set<string>()
  for (const raw of ctx.writtenPaths ?? []) {
    if (!raw) continue
    if (!isAbsolute(raw)) {
      out.add(normalizePath(raw))
      continue
    }
    for (const root of [ctx.executionPath, ctx.workspacePath]) {
      if (!root) continue
      const rel = relative(root, raw)
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
        out.add(normalizePath(rel))
        break
      }
    }
  }
  return out
}

/**
 * F1 — which peer-exempt paths changed, and can anyone be named for them?
 *
 * The peer exemption is direction-blind: `collectChanges` drops a peer-declared
 * path from `files` and `addedLines` without ever asking WHO changed it. "A peer
 * wrote its own file" and "this task wrote into a peer's file" are the same
 * bytes in a diff, and only the first is what the exemption was built for.
 * Live: blueprint 6c4a6a85, T012 changed three files, deleted 69 lines from a
 * spec T004 declares, and the write-set gate reported
 * `pass — 2 file(s) changed, all in set`.
 *
 * Two deliberate choices:
 *
 * • The changed set comes from `--name-only`, not from the added-line scan. A
 *   pure DELETION produces no added line, so the path that started that
 *   incident never even reached `exempted.peer`.
 *
 * • Attribution is ONE `git log --name-only` over `baseline..HEAD` rather than
 *   one `git log -- <path>` per path. Membership in "paths some commit since the
 *   baseline touched" is exactly what the per-path form answers, and this runs
 *   on the task's critical path.
 *
 * A path a peer commit explains stays a clean exemption — the R1.2 behaviour is
 * unchanged. What is left is a change on disk that no commit in the range
 * accounts for: uncommitted, and unattributable from git alone.
 *
 * Mutates `peerChanged` in place (the caller's bucket) and returns the
 * unattributable subset.
 */
async function findPeerUnattributed(opts: {
  ctx: GateTaskContext
  cwd: string
  runner: CommandRunner
  baselineCommit: string
  exemptExact: ReadonlySet<string>
  dirtyBefore: ReadonlySet<string>
  /** `null` when `git diff --name-only` failed — nothing can be attributed. */
  changedNames: ReadonlySet<string> | null
  peerChanged: string[]
}): Promise<string[]> {
  const { ctx, cwd, runner, baselineCommit, exemptExact, dirtyBefore, changedNames, peerChanged } =
    opts
  if (exemptExact.size === 0) return []

  // The diff itself already succeeded, so a failure here is a genuine unknown.
  // Reporting nothing would silently restore the blind pass this exists to stop.
  if (changedNames === null) return [...exemptExact].filter((p) => !dirtyBefore.has(p))

  for (const p of exemptExact) {
    // Pre-existing dirt outranks the peer bucket in `notThisTasks`; keep the
    // same precedence here or a file the user left dirty reads as peer traffic.
    if (changedNames.has(p) && !dirtyBefore.has(p)) peerChanged.push(p)
  }
  if (peerChanged.length === 0) return []

  const committed = await git(
    ['log', '--format=', '--name-only', '-z', `${baselineCommit}..HEAD`],
    cwd,
    runner,
    ctx.signal
  )
  if (committed === null) return [...peerChanged]

  const explained = new Set(splitNulPaths(committed))
  const unattributed = peerChanged.filter((p) => !explained.has(p))
  if (unattributed.length > 0) {
    gateLog.warn(
      `[${ctx.taskId}] ${unattributed.length} peer-exempt path(s) changed with no ` +
        `commit in ${baselineCommit.slice(0, 8)}..HEAD to explain them: ` +
        `${unattributed.slice(0, MAX_LISTED_PATHS).join(', ')}`
    )
  }
  return unattributed
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

// ── Cross-task revert detection (P1b) ──

/** A line one task's commit introduced that is no longer present in the tree. */
export interface DroppedAddition {
  /** Task id parsed from the commit subject. */
  taskId: string
  sha: string
  file: string
  text: string
}

export interface CommitSurvivalScan {
  /** null when the scan could NOT run — the caller reports `unverifiable`. */
  dropped: DroppedAddition[] | null
  /** Why it could not run. Set only when `dropped` is null. */
  reason?: string
  commitsScanned: number
  durationMs: number
}

/**
 * Build commits carry their task id in the subject ("T007: add the notifier").
 *
 * `R###` matters as much as `T###`: VERIFY remediation rounds create real tasks
 * with R-prefixed ids (R001–R003 sit in wave 5 of run 984eac4d), and they are
 * *expected* to revise what the T-tasks built. A `T`-only pattern made every
 * remediation commit invisible to attribution — it could never be recognised as
 * a file's newest writer — so R003 refining T011's sign-off notification read as
 * T011's work being destroyed.
 */
const TASK_ID_IN_SUBJECT = /\b[TR]\d{2,}\b/
// A6 exports the pattern so the build service's commit-subject contract and the
// survival scan's attribution pattern can never drift apart.
export { TASK_ID_IN_SUBJECT }

/** Commits inspected per scan — a bound, not a tuning knob. */
const MAX_SURVIVAL_COMMITS = 60

/**
 * Lines specific enough to attribute. A commit that added `}` proves nothing
 * about a later task deleting one somewhere else, and matching on it would
 * manufacture failures out of ordinary formatting.
 */
function isAttributableLine(text: string): boolean {
  const t = text.trim()
  return t.length >= 8 && /[A-Za-z0-9]/.test(t)
}

/**
 * P1b — did this task destroy work another task already committed?
 *
 * The safety net that does not depend on write-set attribution being right.
 * On the run this was written for, two tasks reverted THREE finished
 * deliverables — `.env.example` + nodemailer pins (T002/T003, complete and
 * verified) and an 89-line notification template (T008, complete and verified)
 * — because a stale baseline put a peer's committed work inside the reverting
 * task's own diff. The write-set gate reported it as that task's violation and
 * the task dutifully reverted it. Nothing re-applies anything.
 *
 * The check: for every commit in `<baseline>..HEAD` whose subject names a
 * DIFFERENT task, are the lines it added still in the tree? Two deliberate
 * narrowings keep it precise:
 *
 *   - files inside the grading task's own write-set are skipped entirely (a
 *     task may rewrite what it owns);
 *   - only the NEWEST peer commit per file is checked, so a line legitimately
 *     superseded by a later peer is not counted against this task.
 *
 * When no commit in range carries a task id the convention does not hold in
 * this workspace, and the scan returns `dropped: null` — `unverifiable`, never
 * a false `fail`.
 */
export async function scanTaskCommitSurvival(opts: {
  cwd: string
  baselineCommit: string | null
  /** The grading task. Its own commits are never checked against it. */
  excludeTaskId?: string
  /** Files the grading task owns; changes there are its business. */
  ownedFiles?: readonly string[]
  runner: CommandRunner
  signal?: AbortSignal
}): Promise<CommitSurvivalScan> {
  const started = Date.now()
  const { cwd, baselineCommit, runner, signal } = opts
  const fail = (reason: string): CommitSurvivalScan => ({
    dropped: null,
    reason,
    commitsScanned: 0,
    durationMs: Date.now() - started
  })

  if (!baselineCommit) return fail('no git baseline commit')

  // %x1f (unit separator) cannot appear in a sha and is vanishingly unlikely in
  // a subject; a newline in the subject would break a space-delimited format.
  const logOut = await git(
    ['log', '--format=%H%x1f%s', `${baselineCommit}..HEAD`],
    cwd,
    runner,
    signal
  )
  if (logOut === null) return fail('git log failed')

  const lines = logOut.split('\n').filter((l) => l.trim() !== '')
  // Nothing was committed since the baseline, so no peer's committed work can
  // have been destroyed. That is a PROVEN pass, not an unprovable one — the
  // distinction matters, because `unverifiable` here would ledger an item on
  // every task of every serial build.
  if (lines.length === 0) {
    return { dropped: [], commitsScanned: 0, durationMs: Date.now() - started }
  }

  const commits: { sha: string; taskId: string }[] = []
  for (const line of lines) {
    const [sha, subject = ''] = line.split('\x1f')
    if (!sha.trim()) continue
    const match = TASK_ID_IN_SUBJECT.exec(subject)
    if (!match) continue
    commits.push({ sha: sha.trim(), taskId: match[0] })
  }
  // Commits exist but none names a task id: something WAS committed and we
  // cannot tell whose it is. Honest answer is `unverifiable`, never a false fail.
  if (commits.length === 0) {
    return fail(
      `${lines.length} commit(s) since the baseline, none naming a task id in its ` +
        'subject — cross-task attribution is not possible in this workspace'
    )
  }

  const owned = new Set((opts.ownedFiles ?? []).map(normalizePath))
  const peers = commits
    .filter((c) => c.taskId !== opts.excludeTaskId)
    .slice(0, MAX_SURVIVAL_COMMITS)

  /** Current content per file: `null` lines = present but not readable as text. */
  const contentCache = new Map<string, { exists: boolean; lines: Set<string> | null }>()
  const contentOf = (rel: string): { exists: boolean; lines: Set<string> | null } => {
    const cached = contentCache.get(rel)
    if (cached) return cached
    const abs = resolveInside(cwd, rel)
    let entry: { exists: boolean; lines: Set<string> | null } = { exists: false, lines: null }
    if (abs && existsSync(abs)) {
      entry = { exists: true, lines: null }
      try {
        if (statSync(abs).size <= MAX_SCAN_BYTES) {
          entry = {
            exists: true,
            lines: new Set(
              readFileSync(abs, 'utf-8')
                .split('\n')
                .map((l) => l.trim())
            )
          }
        }
      } catch {
        /* present but unreadable — treated as "cannot say", never as dropped */
      }
    }
    contentCache.set(rel, entry)
    return entry
  }

  const dropped: DroppedAddition[] = []
  /**
   * Newest commit that TOUCHED each file, with whether it was net-NEGATIVE there.
   *
   * Two rules decide supersession, and both were learned the hard way on run
   * 984eac4d:
   *
   * 1. **By task, never by recency.** An early draft suppressed an older
   *    commit's additions whenever any newer commit added a line to the same
   *    file. That masked the exact harm this gate exists for: `5ef69312 "T005
   *    restore apps/web mail seam to its baseline"` deleted 82 lines from
   *    `mailer.ts` and added 7 back, so it "claimed" the file and hid the 77
   *    lines T008 had committed — the `sendInternalSignoffNotice` export whose
   *    absence (TS2305) killed the run 31 minutes later.
   *
   * 2. **Only a net-negative commit destroys.** Without this the mirror-image
   *    error appears and it is the more common one: a later task REVISING an
   *    earlier task's file is normal work, and during a remediation round it is
   *    the whole job. Every false positive observed has been net-additive
   *    (`R003 +64/-6`, `R002 +5/-1`); both genuine incidents were reverts that
   *    removed far more than they added. Deleting more than you add on someone
   *    else's file is what "destructive" means.
   *
   * Deletion-only commits must still count as touches, or a third error
   * appears: `dee825b7 "T005 keep the mailer belt inside its write-set"` is 271
   * deletions and ZERO additions — T005 walking back its own work — and without
   * it T005 was reported as the victim of a "later task": itself.
   */
  const newestToucher = new Map<string, { taskId: string; sha: string; netNegative: boolean }>()
  let commitsScanned = 0

  for (const commit of peers) {
    const show = await git(
      ['show', '--format=', '-U0', '--no-color', commit.sha],
      cwd,
      runner,
      signal
    )
    if (show === null) continue
    commitsScanned++

    // Per-file add/delete counts for this commit. `+++ b/<path>` is emitted for
    // deletions and additions alike; `/dev/null` marks a removed file. Counted
    // from the diff we already have rather than a second `git show --numstat`.
    const perFile = new Map<string, { added: number; deleted: number }>()
    let current: { added: number; deleted: number } | null = null
    for (const raw of show.split('\n')) {
      if (raw.startsWith('+++ ')) {
        const target = raw.slice(4).trim()
        if (target === '/dev/null') {
          current = null
          continue
        }
        const file = normalizePath(target.replace(/^b\//, ''))
        current = perFile.get(file) ?? { added: 0, deleted: 0 }
        perFile.set(file, current)
        continue
      }
      if (!current) continue
      // Skip the `---` / `+++` headers themselves; only hunk lines count.
      if (raw.startsWith('+') && !raw.startsWith('+++')) current.added++
      else if (raw.startsWith('-') && !raw.startsWith('---')) current.deleted++
    }
    for (const [file, counts] of perFile) {
      if (newestToucher.has(file)) continue
      newestToucher.set(file, {
        taskId: commit.taskId,
        sha: commit.sha,
        netNegative: counts.deleted > counts.added
      })
    }

    for (const added of parseDiffAddedLines(show)) {
      if (owned.has(added.file) || isProbablyBinary(added.file)) continue
      const toucher = newestToucher.get(added.file)
      if (toucher && toucher.sha !== commit.sha) {
        // The same task superseded its own earlier work — its own business.
        if (toucher.taskId === commit.taskId) continue
        // Another task REVISED the file rather than gutting it. Normal work,
        // and the entire point of a remediation round.
        if (!toucher.netNegative) continue
      }
      if (!isAttributableLine(added.text)) continue

      const content = contentOf(added.file)
      if (!content.exists) {
        dropped.push({ taskId: commit.taskId, sha: commit.sha, file: added.file, text: added.text })
        continue
      }
      if (content.lines && !content.lines.has(added.text.trim())) {
        dropped.push({ taskId: commit.taskId, sha: commit.sha, file: added.file, text: added.text })
      }
    }
  }

  return { dropped, commitsScanned, durationMs: Date.now() - started }
}

// ── The gates ──

function gateDestructiveRevert(scan: CommitSurvivalScan): GateResult {
  if (scan.dropped === null) {
    return unverifiable(
      'destructive-revert',
      'analysis_unavailable',
      [scan.reason ?? 'the cross-task commit scan could not run'],
      scan.durationMs
    )
  }
  if (scan.dropped.length === 0) {
    return result(
      'destructive-revert',
      'pass',
      [`${scan.commitsScanned} peer commit(s) scanned — their committed work is intact`],
      { counts: { commitsScanned: scan.commitsScanned }, durationMs: scan.durationMs }
    )
  }

  const byTask = new Map<string, Set<string>>()
  for (const d of scan.dropped) {
    const files = byTask.get(d.taskId) ?? new Set<string>()
    files.add(d.file)
    byTask.set(d.taskId, files)
  }

  const evidence = [
    ...[...byTask].map(
      ([taskId, files]) => `destroyed ${taskId}'s committed work in ${[...files].join(', ')}`
    ),
    ...scan.dropped
      .slice(0, 10)
      .map((d) => `${d.taskId} @${d.sha.slice(0, 8)} ${d.file}: ${d.text.trim().slice(0, 120)}`)
  ]

  return result('destructive-revert', 'fail', evidence, {
    counts: { droppedLines: scan.dropped.length, victimTasks: byTask.size },
    durationMs: scan.durationMs
  })
}

export interface UngatedCommitScan {
  /** null when the scan could NOT run — attribution is then simply absent. */
  commits: { sha: string; subject: string }[] | null
  /** Why it could not run. Set only when `commits` is null. */
  reason?: string
  durationMs: number
}

/**
 * B1 — commits in `<baseline>..HEAD` whose subject carries no task id: work
 * that no gate ever graded and no ledger entry attributes.
 *
 * Both real cascade bugs in the W16 post-mortem (`2e798341` → import cycle,
 * `4d25cfb4` → tenancy assertion) landed as manual terminal commits during the
 * wave, then surfaced later as THE WAVE's failure. Today a red wave reads as
 * the dispatched task's fault even when an ungated commit caused it.
 *
 * Attribution only — never a fail on its own, never a ledger entry. Consistent
 * with the "unverifiable ⇒ ledger, not failure" doctrine: a manual commit the
 * app cannot intercept is a fact to surface, not a verdict to invent.
 *
 * Same `null` = unverifiable contract as `CommitSurvivalScan`: no baseline
 * commit or a failed `git log` yields `commits: null` and the caller reports
 * nothing rather than "zero ungated commits" (which would be a false clean).
 */
export async function scanUngatedCommits(opts: {
  cwd: string
  baselineCommit: string | null
  runner: CommandRunner
  signal?: AbortSignal
}): Promise<UngatedCommitScan> {
  const started = Date.now()
  const { cwd, baselineCommit, runner, signal } = opts
  const fail = (reason: string): UngatedCommitScan => ({
    commits: null,
    reason,
    durationMs: Date.now() - started
  })

  if (!baselineCommit) return fail('no git baseline commit')

  const logOut = await git(
    ['log', '--format=%H%x1f%s', `${baselineCommit}..HEAD`],
    cwd,
    runner,
    signal
  )
  if (logOut === null) return fail('git log failed')

  const commits: { sha: string; subject: string }[] = []
  for (const line of logOut.split('\n')) {
    if (line.trim() === '') continue
    const [sha, subject = ''] = line.split('\x1f')
    if (!sha.trim()) continue
    if (TASK_ID_IN_SUBJECT.test(subject)) continue
    commits.push({ sha: sha.trim(), subject: subject.trim() })
    if (commits.length >= MAX_SURVIVAL_COMMITS) break
  }
  return { commits, durationMs: Date.now() - started }
}

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
    ...(exempted.bookkeeping.length > 0 ? { exemptBookkeeping: exempted.bookkeeping.length } : {}),
    ...(exempted.peerChanged.length > 0 ? { exemptPeerChanged: exempted.peerChanged.length } : {}),
    ...(changes.peerUnattributed.length > 0
      ? { peerUnattributed: changes.peerUnattributed.length }
      : {})
  }

  // BP-UNATTRIBUTED-PASS: the exemption LIST, not just its size. `exemptPeer: 8`
  // was the only trace that eight foreign files sat in the tree while this
  // task's gates ran, and a bare count is unactionable — the reader cannot tell
  // whether the compile that just passed depended on any of them. Live: blueprint
  // 769e6da7 T018 passed `npm run typecheck` against a tree carrying eight
  // peer-exempt files, committed two of its own, and left an import of a symbol
  // that no commit ever added.
  const exemptEvidence =
    exempted.peer.length > 0
      ? [
          `${exempted.peer.length} peer-owned file(s) also changed in the shared ` +
            `worktree — this task neither owns nor commits them:`,
          ...exempted.peer.slice(0, 10).map((f) => `  peer-exempt: ${f}`),
          ...(exempted.peer.length > 10 ? [`  …and ${exempted.peer.length - 10} more`] : [])
        ]
      : []

  if (evaluation.forbidden.length > 0 || evaluation.violations.length > 0) {
    return result(
      'write-set',
      'fail',
      [
        ...evaluation.forbidden.map((f) => `forbidden: ${f}`),
        ...evaluation.violations.map((f) => `outside write-set: ${f}`),
        ...exemptEvidence
      ],
      {
        counts,
        durationMs: Date.now() - started,
        // F11 (1.3) — the structured path list the retry-cleanup sweep is
        // bounded by. Evidence lines are prose for the model; `files` is the
        // machine-readable bound for the kernel's own revert.
        files: [...evaluation.forbidden, ...evaluation.violations]
      }
    )
  }

  // F1 — an exempt path changed and nothing in `baseline..HEAD` explains it.
  // The honest verdict is that this task's write-set cannot be judged: the
  // exemption may be doing its job (a peer's uncommitted work) or hiding this
  // task writing into a peer's file, and the diff cannot tell those apart.
  // Deliberately AFTER the violation branch — a proven violation still fails —
  // and deliberately not a `fail` itself: this gate never blames a task for a
  // change it cannot attribute (see the file's invariant 1).
  if (changes.peerUnattributed.length > 0) {
    const listed = changes.peerUnattributed.slice(0, MAX_LISTED_PATHS)
    return result(
      'write-set',
      'unverifiable',
      [
        `${evaluation.changedCount} file(s) changed and in set, but ` +
          `${changes.peerUnattributed.length} peer-owned path(s) also changed with no ` +
          'commit since the baseline to explain them — authorship cannot be established:',
        ...listed.map((f) => `  unattributed: ${f}`),
        ...(changes.peerUnattributed.length > listed.length
          ? [`  …and ${changes.peerUnattributed.length - listed.length} more`]
          : [])
      ],
      {
        reason: 'analysis_unavailable',
        counts,
        files: changes.peerUnattributed,
        durationMs: Date.now() - started
      }
    )
  }

  return result(
    'write-set',
    'pass',
    [`${evaluation.changedCount} file(s) changed, all in set`, ...exemptEvidence],
    { counts, durationMs: Date.now() - started }
  )
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

  // R1.2 attribution, applied to the one gate that never had it. Every other
  // gate reads the DIFF, which `collectChanges` has already filtered through
  // `notThisTasks`; this one compares DISK against the baseline, so a peer's
  // edit to a file this task happens to declare was reported as this task's
  // violation. That was a false fail on its own; now that the kernel RESTORES
  // what this gate reports, it would also silently overwrite the peer's
  // uncommitted work with pre-session bytes. `exempted.peer` is exactly the
  // changed paths another task declares.
  //
  // Narrower than "skip everything in `exemptFiles`" on purpose: a declared
  // file the peer never touched is not in the diff, so this task's damage to it
  // is still judged.
  const peerOwned = new Set(changes.exempted.peer)
  const comparable = Object.keys(baseline.testsBefore).filter((f) => !peerOwned.has(f))
  const peerSkipped = Object.keys(baseline.testsBefore).length - comparable.length
  if (comparable.length === 0) {
    return unverifiable(
      'test-integrity',
      'no_tests',
      [
        `all ${peerSkipped} captured test file(s) were also changed by a peer task ` +
          `that declares them — not this task's to judge`
      ],
      Date.now() - started
    )
  }
  const peerNote =
    peerSkipped > 0
      ? [`${peerSkipped} declared test file(s) skipped — changed by a peer task that declares them`]
      : []

  const before: Record<string, CapturedTestFile> = {}
  const after: Record<string, TestFileState | null> = {}
  for (const rel of comparable) {
    before[rel] = baseline.testsBefore[rel]
    const abs = resolveInside(ctx.executionPath, rel)
    after[rel] = abs && existsSync(abs) ? hashFile(abs) : null
  }

  const testFileSet = new Set(comparable)
  const evaluation = evaluateTestIntegrity({
    before,
    after,
    addedTestLines: changes.addedLines.filter((l) => testFileSet.has(l.file))
  })

  if (!evaluation.ok) {
    // Every offending path, for the caller that has to put them back. Kept
    // separate from the evidence prose on purpose — nothing should have to
    // parse a sentence to learn which file to restore.
    const offending = Array.from(
      new Set([
        ...evaluation.deleted,
        ...evaluation.modified,
        ...evaluation.countDrops.map((d) => d.file),
        ...evaluation.skipsAdded.map((s) => s.file)
      ])
    )
    return result(
      'test-integrity',
      'fail',
      [
        ...evaluation.deleted.map((f) => `test file deleted: ${f}`),
        // WHICH check tripped, not just that one did: a bare "modified" is
        // undiagnosable after the fact, and it is the line that repeats
        // verbatim when a leftover edit keeps failing the same way.
        ...peerNote,
        ...evaluation.modified.map((f) => {
          const beforeCount = before[f]?.testCount
          const afterCount = after[f]?.testCount
          const counts =
            beforeCount === undefined || afterCount === undefined
              ? ''
              : `, ${beforeCount}→${afterCount} tests`
          return `test file modified (content differs from the pre-session spec${counts}): ${f}`
        }),
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
        files: offending,
        durationMs: Date.now() - started
      }
    )
  }

  // EXTENSION ALLOWANCE: extended files are visible as info, not failures —
  // authoring new tests inside a packet-declared file is a legitimate
  // deliverable (T001 shape), and the builder needs to see it was recognized.
  const extensionLines = evaluation.extended.map((f) => {
    const beforeState = before[f]
    const afterState = after[f]
    return `test file extended ${beforeState?.testCount}→${afterState?.testCount} tests — authoring allowed: ${f}`
  })

  return result(
    'test-integrity',
    'pass',
    [`${comparable.length} test file(s) intact`, ...peerNote, ...extensionLines],
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
  runner: CommandRunner,
  /** P2a — supplied only by the per-task ladder; enables pre-existing discounting. */
  baseline?: GateBaseline,
  /**
   * BP-UNATTRIBUTED-PASS — peer-owned files also changed in the shared worktree.
   * Supplied only by the per-task ladder; wave/drain-point runs grade the whole
   * tree on purpose and have nothing to attribute.
   */
  unattributed?: readonly string[]
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
        [`${command.command} — the runner is not installed on this machine`, ...outcome.output],
        outcome.durationMs
      )
    }
    // P2a — discount diagnostics that were ALREADY there. Done here rather than
    // on the finished GateResult because `result()` bounds evidence to 2 K chars:
    // comparing a truncated error list against a full baseline would silently
    // decide the wrong way on exactly the large failures that matter most.
    const before = baseline?.buildBefore
    if (before?.failed) {
      const current = diagnosticSignatures(outcome.output)
      // Nothing parseable means we cannot attribute anything; keep the fail
      // rather than fail open on a toolchain whose output we do not understand.
      if (current.size > 0) {
        const known = new Set(before.signatures)
        const novel = [...current].filter((sig) => !known.has(sig))
        if (novel.length === 0) {
          return unverifiable(
            name,
            'preexisting_failure',
            [
              `${command.command} is failing, but every error predates this task ` +
                `(${current.size} diagnostic(s), 0 new)`,
              'this task is not the cause and cannot be graded on it — the drain-point gate still fails the build',
              ...[...current].slice(0, 5)
            ],
            outcome.durationMs
          )
        }
        return result(
          name,
          'fail',
          [
            `${command.command} exited ${outcome.exitCode} with ${novel.length} NEW error(s) ` +
              `(${current.size - novel.length} pre-existing, ignored)`,
            ...novel
          ],
          {
            counts: {
              exitCode: outcome.exitCode ?? -1,
              newErrors: novel.length,
              preexistingErrors: current.size - novel.length
            },
            durationMs: outcome.durationMs
          }
        )
      }
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
  // BP-UNATTRIBUTED-PASS: lint/build run against the SHARED worktree, so a pass
  // grades this task's commit plus whatever peers have in flight. When foreign
  // files are present the pass is real but not attributable — T018 typechecked
  // green over eight of them, then committed only its own two, and the tree it
  // was graded on never existed again. The verdict stays `pass` (a downgrade
  // would fire on nearly every concurrent wave and drown the signal), but the
  // contamination now rides along so a green gate followed by a red drain-point
  // gate is diagnosable from the report alone.
  const contaminated = unattributed ?? []
  return result(
    name,
    'pass',
    [
      `${command.command} (${command.provenance})`,
      ...(contaminated.length > 0
        ? [
            `NOT ATTRIBUTABLE to this task alone: ${contaminated.length} peer-owned ` +
              `file(s) were present in the shared worktree during this run`,
            ...contaminated.slice(0, 5).map((f) => `  also-changed: ${f}`),
            ...(contaminated.length > 5 ? [`  …and ${contaminated.length - 5} more`] : [])
          ]
        : [])
    ],
    {
      ...(contaminated.length > 0 ? { counts: { unattributedFiles: contaminated.length } } : {}),
      durationMs: outcome.durationMs
    }
  )
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
    // P2b — say WHICH source came up empty. "no test command resolved" ledgered
    // 15 times on one run told nobody whether the packets carried no test files
    // or the toolchain could not target them, so nothing could be fixed.
    const candidates = taskTestFiles(ctx)
    return unverifiable(
      'task-tests',
      'no_command',
      [
        candidates.length === 0
          ? 'no test command resolved: the packet declares no testFiles and no ' +
            'test-looking path appears in this task’s write-set'
          : `no test command resolved: the detected toolchain cannot target ` +
            `${candidates.length} test file(s) by path`
      ],
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
        [`${command.command} — the runner is not installed on this machine`, ...outcome.output],
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
        if (looksLikeTestFile(caller)) out.add(normalizePath(caller))
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

  // P1b — after the free checks (it costs a `git log` plus one `git show` per
  // peer commit) and before anything that compiles or runs: destroying a peer's
  // finished deliverable is not worth a 30-minute build to confirm.
  if (!shortCircuited) {
    const scan = await scanTaskCommitSurvival({
      cwd: ctx.executionPath,
      baselineCommit: baseline.baselineCommit,
      excludeTaskId: ctx.taskId,
      ownedFiles: [...(ctx.packet?.allowedFiles ?? []), ...ctx.plannedFiles],
      runner,
      signal: ctx.signal
    })
    const gate = gateDestructiveRevert(scan)
    gates.push(gate)
    if (gate.verdict === 'fail') shortCircuited = true
  }

  if (!shortCircuited) {
    for (const name of ctx.commandGates ?? (['lint', 'build'] as const)) {
      const gate = await gateCommand(
        name,
        name === 'lint' ? 'lint' : 'build',
        ctx,
        runner,
        baseline,
        changes.exempted.peer
      )
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
export function buildGateFixInstructions(
  report: GateReport,
  opts?: {
    /**
     * Packet test files the kernel already put back (`restorePacketTestFiles`).
     * Told to the builder because an instruction to restore a file that is
     * ALREADY restored reads as "edit this test file" — the one thing it must
     * not do — and because the next attempt's diff will otherwise look
     * inexplicable to it.
     */
    restoredTestFiles?: readonly string[]
    /**
     * F11 (1.3) — out-of-set files the kernel already reverted to the
     * pre-session state (`sweepOutOfWorksetWrites`). Same reasoning as the
     * restore note: the next attempt must be TOLD what was undone, or its
     * gate verdict ("file clean") contradicts its own memory of having
     * written it, and it "helpfully" re-applies the out-of-set edit.
     */
    revertedFiles?: readonly string[]
  }
): string {
  const failed = report.gates.filter((g) => g.verdict === 'fail')
  if (failed.length === 0) return ''

  const restored = opts?.restoredTestFiles ?? []
  const reverted = opts?.revertedFiles ?? []
  // The fix prompt competes with the failing assertion for the model's
  // attention: a 40-file packet turns the restore note into 40 lines of paths
  // and the actual failure is what gets dropped. `boundEvidence` caps the
  // evidence for the same reason; this caps the list beside it.
  const restoredLines = [
    ...restored.slice(0, MAX_LISTED_PATHS).map((f) => `- ${f}`),
    ...(restored.length > MAX_LISTED_PATHS
      ? [`- …and ${restored.length - MAX_LISTED_PATHS} more`]
      : [])
  ]
  const revertedLines = [
    ...reverted.slice(0, MAX_LISTED_PATHS).map((f) => `- ${f}`),
    ...(reverted.length > MAX_LISTED_PATHS
      ? [`- …and ${reverted.length - MAX_LISTED_PATHS} more`]
      : [])
  ]
  const sections = failed.map((gate) => {
    const header = `### Gate: ${gate.name} — FAILED`
    const body = gate.evidence.map((line) => `- ${line}`).join('\n')
    const instruction = GATE_FIX_HINTS[gate.name] ?? 'Fix the cause reported above.'
    const restoreNote =
      gate.name === 'test-integrity' && restored.length > 0
        ? '\n\n' +
          'The kernel has ALREADY restored these files to their pre-session content:\n' +
          restoredLines.join('\n') +
          '\nDo not edit them again and do not try to revert them yourself — ' +
          'they are back to the specification. Change the implementation instead.'
        : ''
    // F11 (1.3) — the reverted-file note attaches to the write-set gate (the
    // gate whose verdict produced the sweep's bound) on ANY task, and to any
    // failed gate when the sweep ran, so the model is always told what the
    // kernel already undid.
    const revertedNote =
      reverted.length > 0 &&
      (gate.name === 'write-set' || failed.some((g) => g.name === 'write-set'))
        ? '\n\n' +
          'The kernel has ALREADY reverted these out-of-set files to their pre-session state:\n' +
          revertedLines.join('\n') +
          '\nDo not re-apply changes to them — they were outside this task\u2019s write-set and have ' +
          'been undone. Your next attempt is graded on a clean tree; stay inside your write-set.'
        : ''
    return `${header}\n\n${body}\n\n**Required:** ${instruction}${restoreNote}${revertedNote}`
  })

  return (
    'The previous attempt failed deterministic quality gates. ' +
    'These are machine-checked facts, not opinions — fix exactly what is listed.\n\n' +
    sections.join('\n\n') +
    '\n\n' +
    REVERT_SCOPE_RULE
  )
}

/**
 * P1c — the rule that closes the gap a correct gate report cannot.
 *
 * A task handed "outside write-set: .env.example" reasoned its way to `git
 * checkout .env.example` and destroyed a peer's completed, verified deliverable
 * — its own commit message says "T008 re-applies the template and T003
 * re-applies the nodemailer pins". Both had already finished. Nothing
 * re-applies anything. The instruction has to be explicit that a foreign change
 * in your diff is somebody else's finished work, not your mess to clean up.
 */
const REVERT_SCOPE_RULE = [
  '### Scope rule — read before you revert anything',
  '',
  '- Revert ONLY files inside your own write-set.',
  '- NEVER `git checkout`, `git restore`, `git revert` or otherwise roll back a file you do not own.',
  '- Other tasks run in this same tree. A change you did not make that appears in your diff belongs',
  '  to a peer and is very likely already COMPLETE and VERIFIED — leave it exactly as it is.',
  '- Never assume another task will “re-apply” something you removed. It will not.',
  '- If a foreign change genuinely blocks you, say so in your completion block instead of editing it.',
  '- Exception — the test files listed in YOUR OWN task packet: those are this task’s specification,',
  '  not a peer’s work. You still must never weaken them, and the kernel restores them for you if you',
  '  do, so there is never a reason to edit or revert one yourself.'
].join('\n')

const GATE_FIX_HINTS: Partial<Record<GateName, string>> = {
  'write-set':
    'Undo YOUR OWN changes to the files listed above — they are outside this task’s write-set. Undo means removing the edits you made; it does not mean restoring the file to an older revision, which would also delete work other tasks committed. If a listed file contains changes you did not make, leave them and say so instead of editing them.',
  'destructive-revert':
    'You deleted lines another task had already committed. Restore them exactly as they were (`git show <sha>:<file>` shows the version that had them) and then redo your own work on top. Do not reason about whether the other task will re-apply them — it is finished and it will not.',
  'stub-scan':
    'Replace each marker above with a real implementation. Do not delete the line — implement it.',
  'test-integrity':
    'The listed test files are the specification. Do not edit them, and do not revert them yourself — the kernel restores any packet test file an attempt changed. Make the IMPLEMENTATION satisfy the tests instead. If a test genuinely looks wrong, say so in your completion block rather than changing it.',
  lint: 'Fix the reported lint errors. Do not disable the rules.',
  build: 'Fix the reported compile/type errors.',
  'task-tests':
    'Make the listed tests pass by changing the implementation. Editing the tests is checked separately and will fail the task.'
}
