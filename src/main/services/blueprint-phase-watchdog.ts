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

export class PhaseActivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private rejectFn: ((err: Error) => void) | null = null
  private _stalled = false

  constructor(
    private readonly stallTimeoutMs: number,
    private readonly phaseName: string
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

  /**
   * Record activity — call on each chunk to reset the stall timer.
   * Safe to call after dispose() (no-op).
   */
  touch(): void {
    if (!this.rejectFn) return // disposed or not started
    this.resetTimer()
  }

  /**
   * Clean up the timer. Call in finally block.
   * Idempotent — safe to call multiple times.
   */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.rejectFn = null
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this._stalled = true
      const minuteStr = Math.round(this.stallTimeoutMs / 60_000)
      const msg = `${this.phaseName} phase stalled — no activity for ${minuteStr}m`
      bpLog.warn(`[stall-watchdog] ${msg}`)
      this.rejectFn?.(new Error(msg))
    }, this.stallTimeoutMs)
  }
}
