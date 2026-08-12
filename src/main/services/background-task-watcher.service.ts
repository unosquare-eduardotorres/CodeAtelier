/**
 * Background Task Watcher — notifies and wakes the agent when a watched
 * background process exits.
 *
 * The process-manager MCP server spawns processes `detached` and persists them
 * to `<workspace>/.pm-state/manifest.json`.  Those processes outlive the agent
 * turn that started them, and nothing in the app could ever report back on
 * them — an agent that said "I'll check back in 10 minutes" was making a
 * promise the architecture could not keep.
 *
 * This service closes that loop.  It polls the manifests from the **main**
 * process (no MCP → main bridge needed), and when a process the agent opted in
 * to (`run_background({ notifyOnExit: true })`) exits it:
 *
 *   1. dispatches a completion notification (toast / OS notification), and
 *   2. starts a **hidden** chat turn so the agent writes a visible reply.
 *
 * Safety: auto-resume is opt-in per process, capped at one resume per process
 * and a small number per conversation, and never fires for a process that
 * exited while the app was closed.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { app } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  BackgroundProcessInfo,
  ProcessCancelWatchResult,
  ProcessStopResult
} from '../../shared/types'
import { formatDuration } from '../../shared/format-duration'
import { safeWindowSend } from '../ipc/safe-send'
import { conversationRepository, workspaceRepository } from '../db/repositories'
import { lifecycleRegistry } from './conversation-lifecycle'
import { conversationStateMachine } from './conversation-state-machine'
import { notificationService } from './notification.service'

// ── Configuration ──

const POLL_INTERVAL_MS = 5000
/** Give up auto-resuming after this many busy-conversation retries (~5 min). */
const MAX_RESUME_ATTEMPTS = 60
/** Hard ceiling on unattended agent wake-ups per conversation, per app session. */
const MAX_RESUMES_PER_CONVERSATION = 5
/** Mirrors MAX_CONCURRENT_STREAMS in chat-stream.service.ts. */
const MAX_CONCURRENT_STREAMS = 3
const MAX_TAIL_CHARS = 4000
const SIGTERM_GRACE_MS = 3000

const STATE_DIR_NAME = '.pm-state'
const MANIFEST_NAME = 'manifest.json'
const LOGS_DIR_NAME = 'logs'

// ── Types ──

/** One entry of `<workspace>/.pm-state/manifest.json`, written by the MCP server. */
export interface ProcessManifestEntry {
  pid: number
  label: string
  command: string
  cwd: string
  startedAt: number
  logFile: string
  notifyOnExit?: boolean
}

/** A process this service is watching for exit. */
export interface WatchedProcess {
  pid: number
  label: string
  command: string
  cwd: string
  logFile: string
  startedAt: number
  workspaceId: string
  /** Conversation to wake on exit — bound at detection time, may be null. */
  conversationId: string | null
  /** Busy-conversation retries so far. */
  resumeAttempts: number
}

/** Exit details, from an `exit-<pid>.json` record or inferred from liveness. */
export interface ProcessExitInfo {
  pid: number
  exitCode: number | null
  exitedAt: number
  tail: string
}

/** One workspace that can hold a process manifest. */
interface WorkspacePath {
  workspaceId: string
  repoPath: string
}

// ── Pure Helpers (exported for tests) ──

// Re-exported so callers of this service keep a single import site.
export { formatDuration }

/**
 * Notification status + one-line summary for a finished process.
 *
 * Exit code 0 is a success; a non-zero *or unknown* code is reported as a
 * failure, because "we could not confirm it succeeded" is the safer default to
 * put in front of a user.
 */
export function summarizeExit(
  watched: WatchedProcess,
  exit: ProcessExitInfo
): { status: 'completed' | 'failed'; summary: string } {
  const duration = formatDuration(exit.exitedAt - watched.startedAt)
  if (exit.exitCode === 0) {
    return {
      status: 'completed',
      summary: `${watched.label} finished successfully after ${duration}`
    }
  }
  const code = exit.exitCode === null ? 'an unknown code' : `code ${exit.exitCode}`
  return { status: 'failed', summary: `${watched.label} exited with ${code} after ${duration}` }
}

/**
 * The synthetic user message that wakes the agent.
 *
 * Saved hidden, so the user sees only the agent's reply — which is the whole
 * point: the promise of "I'll tell you when it's done" is finally kept.
 */
export function buildResumePrompt(watched: WatchedProcess, exit: ProcessExitInfo): string {
  const duration = formatDuration(exit.exitedAt - watched.startedAt)
  const code =
    exit.exitCode === null
      ? 'an unknown exit code (the app did not observe the exit directly)'
      : `exit code ${exit.exitCode}`
  const tail = exit.tail.length > MAX_TAIL_CHARS ? exit.tail.slice(-MAX_TAIL_CHARS) : exit.tail

  return [
    `[Background process finished]`,
    ``,
    `The background process you started has exited.`,
    `  Command: ${watched.command}`,
    `  PID: ${watched.pid}`,
    `  Result: ${code} after ${duration}`,
    ``,
    `Last output:`,
    '```',
    tail || '(no output captured)',
    '```',
    ``,
    `Report this result to the user now. If it failed, diagnose the cause from the output above.`,
    `Do not re-run the command unless the user asks.`
  ].join('\n')
}

/** Signal-0 liveness check on the leader PID (cross-platform). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Kill a process and its descendants, matching the MCP server's behaviour. */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  // Defence in depth. The POSIX branch below signals `-pid` (the process
  // group), and `kill(-1, …)` means "every process this user owns". Callers are
  // supposed to have resolved the PID against a manifest first; this makes the
  // amplification unreachable even if one of them ever regresses.
  if (!Number.isInteger(pid) || pid <= 1) {
    log.warn(`[BackgroundTaskWatcher] Refusing to signal unsafe pid ${pid}`)
    return
  }
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /PID ${pid} /T${signal === 'SIGKILL' ? ' /F' : ''}`, {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      /* already dead */
    }
  } else {
    try {
      // Negative PID = process group. Children are spawned detached, so PGID == PID.
      process.kill(-pid, signal)
    } catch {
      /* group may not exist */
    }
  }
}

// ── Service ──

class BackgroundTaskWatcherService {
  private timer: ReturnType<typeof setInterval> | null = null
  private watched = new Map<number, WatchedProcess>()
  /** Auto-resumes fired per conversation this app session — hard token guard. */
  private resumesPerConversation = new Map<string, number>()
  /** Reentrancy guard — a slow tick must not overlap the next one. */
  private ticking = false
  private mainWindow: Electron.BrowserWindow | null = null
  private stateFilePath: string | null = null

  setMainWindow(win: Electron.BrowserWindow): void {
    this.mainWindow = win
  }

  start(stateFilePath?: string): void {
    if (this.timer) return
    this.stateFilePath = stateFilePath ?? this.defaultStateFilePath()
    this.loadState()
    this.timer = setInterval(() => {
      void this.tick()
    }, POLL_INTERVAL_MS)
    this.timer.unref?.()
    // Discover immediately rather than after a full interval: a process spawned
    // by the turn that just ended would otherwise go unseen for 5s, by which
    // time the streaming conversation it belongs to is no longer identifiable.
    void this.tick()
    log.info('[BackgroundTaskWatcher] Started — polling every', POLL_INTERVAL_MS, 'ms')
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.saveState()
    log.info('[BackgroundTaskWatcher] Stopped')
  }

  // ── Public API (used by process.ipc.ts) ──

  /** All tracked background processes across every workspace, for the UI. */
  listProcesses(): BackgroundProcessInfo[] {
    const result: BackgroundProcessInfo[] = []
    for (const { workspaceId, repoPath } of this.workspacePaths()) {
      for (const entry of this.readManifest(repoPath)) {
        result.push({
          pid: entry.pid,
          label: entry.label,
          command: entry.command,
          cwd: entry.cwd,
          startedAt: entry.startedAt,
          uptimeMs: Date.now() - entry.startedAt,
          alive: isProcessAlive(entry.pid),
          workspaceId,
          watched: this.watched.has(entry.pid)
        })
      }
    }
    return result.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Stop a background process: SIGTERM, 3s grace, then SIGKILL. */
  async stopProcess(pid: number): Promise<ProcessStopResult> {
    // Only ever signal a process we can prove we spawned. The kill below targets
    // the process *group* (`-pid`), so an arbitrary PID arriving from the
    // renderer would be a broadcast rather than a targeted stop.
    if (!this.findTrackedEntry(pid)) {
      log.warn(
        `[BackgroundTaskWatcher] Refusing to stop pid ${pid} — not in any workspace manifest`
      )
      return { stopped: false, alreadyExited: false, reason: 'untracked' }
    }

    // Cancel any watch first — a user-initiated stop must not wake the agent.
    this.watched.delete(pid)
    this.saveState()

    if (!isProcessAlive(pid)) {
      this.forgetProcess(pid)
      this.emitChanged()
      return { stopped: true, alreadyExited: true }
    }

    killProcessTree(pid, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, SIGTERM_GRACE_MS))
    if (isProcessAlive(pid)) {
      killProcessTree(pid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    const stopped = !isProcessAlive(pid)
    this.forgetProcess(pid)
    this.emitChanged()
    log.info(`[BackgroundTaskWatcher] Stopped process ${pid} (confirmed=${stopped})`)
    return { stopped, alreadyExited: false }
  }

  /** Disarm the auto-resume for a process without killing it. */
  cancelWatch(pid: number): ProcessCancelWatchResult {
    const had = this.watched.delete(pid)
    if (!had) {
      // Nothing was armed. Say whether the process is even ours, so the UI can
      // explain the no-op instead of silently doing nothing.
      return {
        cancelled: false,
        ...(this.findTrackedEntry(pid) ? {} : { reason: 'untracked' as const })
      }
    }
    this.saveState()
    this.emitChanged()
    log.info(`[BackgroundTaskWatcher] Auto-resume cancelled for pid ${pid}`)
    return { cancelled: true }
  }

  // ── Poll Loop ──

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // Resolved once per tick and threaded through: each lookup hits
      // workspaceRepository.findAll(), and doing it per watched process turned
      // one poll into a dozen identical queries.
      const workspaces = this.workspacePaths()
      await this.discoverNewWatches(workspaces)
      await this.processExits(workspaces)
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] Tick error (non-fatal):', err)
    } finally {
      this.ticking = false
    }
  }

  /** Pick up manifest entries that opted in to notifyOnExit and aren't watched yet. */
  private async discoverNewWatches(
    workspaces: WorkspacePath[] = this.workspacePaths()
  ): Promise<void> {
    let added = false
    for (const { workspaceId, repoPath } of workspaces) {
      for (const entry of this.readManifest(repoPath)) {
        if (entry.notifyOnExit !== true) continue
        if (this.watched.has(entry.pid)) continue
        // A dead PID at discovery time means we missed the exit entirely
        // (app was closed) — record nothing rather than fire a stale wake-up.
        if (!isProcessAlive(entry.pid)) continue

        this.watched.set(entry.pid, {
          pid: entry.pid,
          label: entry.label,
          command: entry.command,
          cwd: entry.cwd,
          logFile: entry.logFile,
          startedAt: entry.startedAt,
          workspaceId,
          conversationId: await this.resolveConversationId(workspaceId),
          resumeAttempts: 0
        })
        added = true
        log.info(
          `[BackgroundTaskWatcher] Watching pid ${entry.pid} ("${entry.label}") in workspace ${workspaceId}`
        )
      }
    }
    if (added) {
      this.saveState()
      this.emitChanged()
    }
  }

  /** Fire notification + auto-resume for any watched process that has exited. */
  private async processExits(workspaces: WorkspacePath[] = this.workspacePaths()): Promise<void> {
    for (const watched of [...this.watched.values()]) {
      const exit = this.detectExit(watched, workspaces)
      if (!exit) continue

      if (exit === 'cancelled') {
        // The agent stopped this process on purpose. Reporting a "failed" exit
        // and waking it up to explain its own kill would be pure noise.
        this.watched.delete(watched.pid)
        this.saveState()
        this.emitChanged()
        log.info(
          `[BackgroundTaskWatcher] pid ${watched.pid} was cancelled (no exit record, no manifest entry) — watch dropped silently`
        )
        continue
      }

      const handled = await this.handleExit(watched, exit)
      if (handled) {
        this.watched.delete(watched.pid)
        this.saveState()
        this.emitChanged()
      }
    }
  }

  /**
   * Has this process exited, and does anyone need to hear about it?
   *
   *   exit record present            → exited, with the real exit code
   *   no record, still in manifest   → exited; the MCP server died first, so the
   *                                    code is unknown
   *   no record, gone from manifest  → **cancelled**: `stop_process` removed the
   *                                    entry, i.e. the agent killed it on purpose
   *   no record, process alive       → still running
   */
  private detectExit(
    watched: WatchedProcess,
    workspaces: WorkspacePath[] = this.workspacePaths()
  ): ProcessExitInfo | 'cancelled' | null {
    const repoPath = this.repoPathForWorkspace(watched.workspaceId, workspaces)
    const recordPath = repoPath ? join(repoPath, STATE_DIR_NAME, `exit-${watched.pid}.json`) : null

    if (recordPath && existsSync(recordPath)) {
      try {
        const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as {
          exitCode?: number | null
          exitedAt?: number
          tail?: string
        }
        unlinkSync(recordPath) // consume it
        return {
          pid: watched.pid,
          exitCode: record.exitCode ?? null,
          exitedAt: record.exitedAt ?? Date.now(),
          tail: record.tail ?? ''
        }
      } catch (err) {
        log.debug('[BackgroundTaskWatcher] Bad exit record — falling back to liveness:', err)
        try {
          unlinkSync(recordPath)
        } catch {
          /* ignore */
        }
      }
    }

    if (isProcessAlive(watched.pid)) return null

    // Dead with no exit record. The manifest tells us which of the two it was:
    // the MCP server only drops an entry when `stop_process` (or reconnect
    // cleanup) removes it, so a missing entry means a deliberate kill.
    const stillListed = repoPath
      ? this.readManifest(repoPath).some((e) => e.pid === watched.pid)
      : false
    if (!stillListed) return 'cancelled'

    return {
      pid: watched.pid,
      exitCode: null,
      exitedAt: Date.now(),
      tail: this.readLogTail(watched, workspaces)
    }
  }

  /**
   * Notify + auto-resume.  Returns false when the conversation is busy, so the
   * caller keeps the watch and retries on the next tick.
   */
  private async handleExit(watched: WatchedProcess, exit: ProcessExitInfo): Promise<boolean> {
    const { status, summary } = summarizeExit(watched, exit)

    // 1. Notify on the first attempt only — retries must not re-toast.
    if (watched.resumeAttempts === 0) {
      this.notify(watched, status, summary)
    }

    // 2. Auto-resume — nothing to wake if no conversation was bound.
    if (!watched.conversationId) {
      log.info(
        `[BackgroundTaskWatcher] pid ${watched.pid} exited — no conversation bound, notify only`
      )
      return true
    }

    const resumes = this.resumesPerConversation.get(watched.conversationId) ?? 0
    if (resumes >= MAX_RESUMES_PER_CONVERSATION) {
      log.warn(
        `[BackgroundTaskWatcher] Auto-resume cap (${MAX_RESUMES_PER_CONVERSATION}) reached for ` +
          `conversation ${watched.conversationId} — notify only for pid ${watched.pid}`
      )
      return true
    }

    if (!this.canResume(watched.conversationId)) {
      watched.resumeAttempts++
      if (watched.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        log.warn(
          `[BackgroundTaskWatcher] Gave up auto-resuming pid ${watched.pid} after ` +
            `${watched.resumeAttempts} busy retries — the notification was already delivered`
        )
        return true
      }
      return false // keep the watch, retry next tick
    }

    try {
      await this.doResume(watched.conversationId, buildResumePrompt(watched, exit))
      this.resumesPerConversation.set(watched.conversationId, resumes + 1)
      log.info(
        `[BackgroundTaskWatcher] Auto-resumed conversation ${watched.conversationId} for pid ${watched.pid}`
      )
    } catch (err) {
      // A throw here means the lock was taken between the check and the call.
      watched.resumeAttempts++
      if (watched.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
        log.warn(
          `[BackgroundTaskWatcher] Auto-resume permanently failed for pid ${watched.pid}:`,
          err
        )
        return true
      }
      log.debug('[BackgroundTaskWatcher] Auto-resume deferred:', err)
      return false
    }

    return true
  }

  /**
   * Start the hidden wake-up turn.
   *
   * The user message is saved hidden, so the user sees only the agent's reply.
   * Prompt optimization is skipped — this text is already machine-authored.
   */
  private async doResume(conversationId: string, prompt: string): Promise<void> {
    const { chatStreamService } = await import('./chat-stream.service')
    await chatStreamService.stream(conversationId, prompt, undefined, {
      hidden: true,
      optimizePrompt: false
    })
  }

  /** Mirror chat-stream's admission gates without touching its private state. */
  private canResume(conversationId: string): boolean {
    try {
      const active = lifecycleRegistry.active()
      if (active.some((s) => s.conversationId === conversationId)) return false
      if (active.length >= MAX_CONCURRENT_STREAMS) return false
      if (!conversationStateMachine.isIdle(conversationId)) return false
      return true
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] canResume check failed:', err)
      return false
    }
  }

  private notify(watched: WatchedProcess, status: 'completed' | 'failed', summary: string): void {
    try {
      const ws = workspaceRepository.findById(watched.workspaceId)
      notificationService.dispatch({
        workspaceId: watched.workspaceId,
        workspaceName: ws?.name ?? 'Workspace',
        // `service` is the notification's rate-limit key and there is no
        // background-process member to use, so two builds finishing within 3s
        // coalesce into one toast. Accepted: the agent's reply still lands in
        // both conversations, and the alternative is a union change that
        // ripples through grouping, labels and sounds.
        service: 'chat',
        status,
        summary,
        // Click-to-navigate must land on the conversation that will receive the
        // reply — not merely on "chat".
        entityId: watched.conversationId ?? undefined,
        targetPage: 'chat'
      })
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] Notification dispatch failed:', err)
    }
  }

  // ── Binding Helpers ──

  /**
   * Which conversation should hear about this process?
   *
   * Best effort by design, in descending order of confidence:
   *   1. a conversation streaming in this workspace right now — almost always
   *      the turn that spawned the process;
   *   2. the last active chat, for the common case where the spawning turn has
   *      already ended;
   *   3. the workspace's first conversation — a guess, and logged as one.
   */
  private async resolveConversationId(workspaceId: string): Promise<string | null> {
    try {
      const streaming = this.streamingConversationId(workspaceId)
      if (streaming) return streaming

      const lastActive = await this.lastActiveConversationId()
      if (lastActive && this.conversationWorkspaceId(lastActive) === workspaceId) return lastActive

      // findByWorkspace is ORDER BY sort_order ASC — the pinned/first chat, not
      // the recent one. Better than nothing, but the user should not be
      // surprised silently when the reply shows up somewhere unexpected.
      const fallback = this.firstConversationId(workspaceId)
      if (fallback) {
        log.warn(
          `[BackgroundTaskWatcher] No streaming or recent chat in workspace ${workspaceId} — ` +
            `binding to conversation ${fallback} is a guess`
        )
      }
      return fallback
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] Conversation binding failed:', err)
      return null
    }
  }

  // The three binding sources below are separate methods so tests can replace
  // them per instance — stubbing the shared repository singletons is unsafe
  // when the test harness runs async tests concurrently.

  /** A conversation streaming in this workspace right now, if any. */
  private streamingConversationId(workspaceId: string): string | null {
    for (const stream of lifecycleRegistry.active()) {
      const conv = conversationRepository.findById(stream.conversationId)
      if (conv?.workspaceId === workspaceId) return conv.id
    }
    return null
  }

  private conversationWorkspaceId(conversationId: string): string | null {
    return conversationRepository.findById(conversationId)?.workspaceId ?? null
  }

  private firstConversationId(workspaceId: string): string | null {
    return conversationRepository.findByWorkspace(workspaceId)[0]?.id ?? null
  }

  /**
   * The chat the user was last talking to, if a session is running.
   *
   * Imported lazily: chat-agent.service pulls in the entire agent stack, and
   * this module is loaded by the watcher's own tests and by process IPC.
   */
  private async lastActiveConversationId(): Promise<string | null> {
    try {
      const { chatAgentService } = await import('./chat-agent.service')
      return chatAgentService.getCurrentConversationId()
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] Last-active conversation lookup failed:', err)
      return null
    }
  }

  /** The manifest entry for a PID, or null when we did not spawn it. */
  private findTrackedEntry(
    pid: number,
    workspaces: WorkspacePath[] = this.workspacePaths()
  ): { workspaceId: string; repoPath: string; entry: ProcessManifestEntry } | null {
    for (const { workspaceId, repoPath } of workspaces) {
      for (const entry of this.readManifest(repoPath)) {
        if (entry.pid === pid) return { workspaceId, repoPath, entry }
      }
    }
    return null
  }

  private workspacePaths(): WorkspacePath[] {
    try {
      return workspaceRepository
        .findAll()
        .filter((ws) => !!ws.repoPath)
        .map((ws) => ({ workspaceId: ws.id, repoPath: ws.repoPath }))
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] Workspace enumeration failed:', err)
      return []
    }
  }

  private repoPathForWorkspace(
    workspaceId: string,
    workspaces: WorkspacePath[] = this.workspacePaths()
  ): string | null {
    return workspaces.find((w) => w.workspaceId === workspaceId)?.repoPath ?? null
  }

  private readManifest(repoPath: string): ProcessManifestEntry[] {
    try {
      const manifestPath = join(repoPath, STATE_DIR_NAME, MANIFEST_NAME)
      if (!existsSync(manifestPath)) return []
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
      return Array.isArray(parsed) ? (parsed as ProcessManifestEntry[]) : []
    } catch {
      return []
    }
  }

  private readLogTail(
    watched: WatchedProcess,
    workspaces: WorkspacePath[] = this.workspacePaths()
  ): string {
    try {
      const repoPath = this.repoPathForWorkspace(watched.workspaceId, workspaces)
      if (!repoPath || !watched.logFile) return ''
      const logPath = join(repoPath, STATE_DIR_NAME, LOGS_DIR_NAME, watched.logFile)
      if (!existsSync(logPath)) return ''
      const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
      return lines.slice(-50).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * Drop a process from the manifest so the UI stops listing it.
   *
   * Racy by construction: a live MCP server owns this file and may rewrite the
   * entry back between our read and its next `writeManifest()`. We accept that
   * — the server prunes exited entries itself and the popover re-polls every
   * 3s, so the row disappears either way. A lock file is not worth it.
   */
  private forgetProcess(pid: number): void {
    for (const { repoPath } of this.workspacePaths()) {
      try {
        const manifestPath = join(repoPath, STATE_DIR_NAME, MANIFEST_NAME)
        if (!existsSync(manifestPath)) continue
        const entries = this.readManifest(repoPath)
        if (!entries.some((e) => e.pid === pid)) continue
        writeFileSync(
          manifestPath,
          JSON.stringify(
            entries.filter((e) => e.pid !== pid),
            null,
            2
          )
        )
      } catch {
        /* non-critical */
      }
    }
  }

  private emitChanged(): void {
    try {
      const win = this.mainWindow
      if (!win || win.isDestroyed()) return
      safeWindowSend(win, IPC_CHANNELS.PROCESS_CHANGED)
    } catch {
      /* renderer may be gone */
    }
  }

  // ── Persistence ──
  //
  // Ephemeral operational state, not domain data — a JSON file in userData
  // rather than a table (and therefore no schema migration).

  private defaultStateFilePath(): string {
    try {
      return join(app.getPath('userData'), 'background-watches.json')
    } catch {
      return join(process.cwd(), '.background-watches.json')
    }
  }

  private loadState(): void {
    if (!this.stateFilePath || !existsSync(this.stateFilePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'))
      if (!Array.isArray(parsed)) return
      const workspaces = this.workspacePaths()
      let pruned = 0
      for (const entry of parsed as WatchedProcess[]) {
        // No launch-time catch-up: a process that already exited while the app
        // was closed gets no notification and no wake-up. The moment has passed
        // and an unattended agent turn for it would be pure surprise.
        if (!isProcessAlive(entry.pid)) {
          pruned++
          continue
        }
        // A live PID is not proof it is *our* PID — the OS recycles them, and a
        // restart is exactly when that bites. The manifest is the MCP server's
        // own record of what it spawned, so require an identity match on it.
        if (!this.matchesManifest(entry, workspaces)) {
          pruned++
          continue
        }
        this.watched.set(entry.pid, { ...entry, resumeAttempts: 0 })
      }
      log.info(
        `[BackgroundTaskWatcher] Restored ${this.watched.size} watch(es), pruned ${pruned} (exited or no longer in the manifest)`
      )
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] State load failed:', err)
    }
  }

  /** Is this restored watch still the same process the MCP server spawned? */
  private matchesManifest(entry: WatchedProcess, workspaces: WorkspacePath[]): boolean {
    const tracked = this.findTrackedEntry(entry.pid, workspaces)
    if (!tracked) return false
    // startedAt is stable across writeManifest() calls (it is copied from the
    // tracked process, and preserved verbatim on reconnect), so pid + startedAt
    // + command is a safe identity for a recycled-PID check.
    return tracked.entry.startedAt === entry.startedAt && tracked.entry.command === entry.command
  }

  private saveState(): void {
    if (!this.stateFilePath) return
    try {
      mkdirSync(dirname(this.stateFilePath), { recursive: true })
      writeFileSync(this.stateFilePath, JSON.stringify([...this.watched.values()], null, 2))
    } catch (err) {
      log.debug('[BackgroundTaskWatcher] State save failed:', err)
    }
  }
}

export const backgroundTaskWatcherService = new BackgroundTaskWatcherService()
export { BackgroundTaskWatcherService }
