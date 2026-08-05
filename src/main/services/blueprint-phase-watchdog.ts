/**
 * Blueprint Phase Activity Watchdog — detects stalled blueprint phases.
 *
 * Unlike the flat 30-minute PHASE_TIMEOUT_MS wall-clock cap, this watchdog
 * monitors *activity* (chunk arrival). If no chunk arrives for 5 minutes,
 * the phase is presumed stalled and the race promise rejects — surfacing
 * the error to the user in ~5 minutes instead of ~30.
 *
 * Usage in phase services:
 * ```ts
 * const stallWatchdog = new PhaseActivityWatchdog(STALL_TIMEOUT_MS, 'PLAN')
 * session.on('chunk', () => stallWatchdog.touch())
 * try {
 *   await Promise.race([sendPromise, timeoutPromise, abortPromise, stallWatchdog.promise])
 * } finally {
 *   stallWatchdog.dispose()
 * }
 * ```
 *
 * The 30-min absolute cap remains as the outer bound.
 */

import log from 'electron-log'

const bpLog = log.scope('blueprint-watchdog')

/** Default stall threshold: 5 minutes of no chunk activity. */
export const STALL_TIMEOUT_MS = 5 * 60_000

/**
 * The only two clock primitives this watchdog needs. Injectable so tests can
 * advance time deterministically instead of sleeping: with real timers a
 * "did NOT fire" assertion has to out-wait the threshold, which turns into a
 * wall-clock race against event-loop contention on a loaded runner.
 */
export interface WatchdogTimers {
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const REAL_TIMERS: WatchdogTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle)
}

export class PhaseActivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private rejectFn: ((err: Error) => void) | null = null
  private _stalled = false
  private _paused = false

  constructor(
    private readonly stallTimeoutMs: number,
    private readonly phaseName: string,
    private readonly timers: WatchdogTimers = REAL_TIMERS
  ) {}

  /** Whether the watchdog has detected a stall. */
  get stalled(): boolean {
    return this._stalled
  }

  /**
   * Create a promise that rejects when no touch() is received within
   * stallTimeoutMs. Must only be called once per watchdog instance.
   * The timer starts immediately on first access.
   */
  get promise(): Promise<void> {
    return new Promise<void>((_, reject) => {
      this.rejectFn = reject
      this.resetTimer()
    })
  }

  /** Whether the watchdog is currently paused (e.g. awaiting user input). */
  get paused(): boolean {
    return this._paused
  }

  /**
   * Pause the watchdog — stops the stall timer without disposing.
   * Used when awaiting user input (ask_user bridge) to prevent false stalls.
   */
  pause(): void {
    if (this._paused) return
    this._paused = true
    if (this.timer) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    bpLog.info(`[stall-watchdog] ${this.phaseName} paused — awaiting user input`)
  }

  /**
   * Resume the watchdog — restarts the stall timer.
   * Called after the user answers the ask_user question.
   */
  resume(): void {
    if (!this._paused) return
    this._paused = false
    if (this.rejectFn) {
      this.resetTimer()
    }
    bpLog.info(`[stall-watchdog] ${this.phaseName} resumed`)
  }

  /**
   * Record activity — call on each chunk to reset the stall timer.
   * Safe to call after dispose() (no-op). No-op while paused.
   */
  touch(): void {
    if (!this.rejectFn || this._paused) return // disposed, not started, or paused
    this.resetTimer()
  }

  /**
   * Clean up the timer. Call in finally block.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    if (this.timer) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
    this.rejectFn = null
  }

  private resetTimer(): void {
    if (this.timer) this.timers.clearTimeout(this.timer)
    this.timer = this.timers.setTimeout(() => {
      this._stalled = true
      const minuteStr = Math.round(this.stallTimeoutMs / 60_000)
      const msg = `${this.phaseName} phase stalled — no activity for ${minuteStr}m`
      bpLog.warn(`[stall-watchdog] ${msg}`)
      this.rejectFn?.(new Error(msg))
    }, this.stallTimeoutMs)
  }
}

// ── Non-interactive phase ask_user auto-responder ──

/**
 * Wire an auto-responder to a session's askQuestion event for non-interactive phases
 * (specify, plan, tasks, review, verify). If the model calls ask_user during these
 * phases, immediately respond so the turn doesn't deadlock waiting for user input.
 *
 * Returns a cleanup function to remove the listener.
 */
export function wireAskUserAutoResponder(
  session: { on: (event: string, handler: (...args: unknown[]) => void) => void; off: (event: string, handler: (...args: unknown[]) => void) => void; respondToAskUser: (requestId: string, response: string) => void },
  phaseName: string
): () => void {
  const handler = (data: unknown): void => {
    const { requestId } = data as { requestId?: string }
    if (!requestId) return
    bpLog.info(`[askUser-auto-responder] ${phaseName} phase — auto-responding to ask_user (non-interactive phase)`)
    session.respondToAskUser(
      requestId,
      `Non-interactive phase (${phaseName}) — proceed with best judgment and emit the required fenced block.`
    )
  }
  session.on('askQuestion', handler)
  return () => session.off('askQuestion', handler)
}
