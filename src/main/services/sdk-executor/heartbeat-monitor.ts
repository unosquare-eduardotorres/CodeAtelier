import log from 'electron-log/main'

const sdkLog = log.scope('SDKExecutor')

/**
 * Heartbeat / stall detection for SDK queries.
 *
 * Sets a periodic timer that checks for activity. When the timer fires
 * and no activity has been recorded, it logs a stall warning.
 * Callers should call `touch()` on each SDK message to reset the activity timer.
 */
export class HeartbeatMonitor {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityAt: number = Date.now()
  private _pendingHeartbeat = false
  private readonly stallThresholdMs = 60_000

  /** Whether a heartbeat event is pending (timer fired between generator iterations) */
  get pendingHeartbeat(): boolean {
    return this._pendingHeartbeat
  }

  constructor(private readonly intervalMs: number) {}

  /**
   * Start the heartbeat timer. Must be called before the message loop.
   */
  start(): void {
    if (this.intervalMs <= 0) return

    this.lastActivityAt = Date.now()
    this.heartbeatTimer = setInterval(() => {
      const stalledMs = Date.now() - this.lastActivityAt
      if (stalledMs > this.stallThresholdMs) {
        sdkLog.warn(`SDK query appears stalled — no activity for ${Math.round(stalledMs / 1000)}s`)
      }
      this._pendingHeartbeat = true
    }, this.intervalMs)
  }

  /**
   * Record activity — call on each SDK message to reset stall detection.
   */
  touch(): void {
    this.lastActivityAt = Date.now()
  }

  /**
   * Consume the pending heartbeat flag. Returns true if a heartbeat was pending.
   */
  consumeHeartbeat(): boolean {
    if (this._pendingHeartbeat) {
      this._pendingHeartbeat = false
      return true
    }
    return false
  }

  /**
   * Stop the heartbeat timer. Call in finally block.
   */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }
}
