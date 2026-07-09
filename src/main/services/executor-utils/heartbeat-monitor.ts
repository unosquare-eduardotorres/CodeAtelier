import { executorLog } from './index'

/** Options for HeartbeatMonitor constructor. */
export interface HeartbeatMonitorOptions {
  /** Heartbeat interval in milliseconds. */
  intervalMs: number
  /**
   * Optional escalation hook — fired once when the stall threshold is first
   * crossed (60s of no activity). Reset by `touch()`. Lets callers react to
   * stalls without hand-rolling their own watchdog.
   *
   * The CLI executor passes nothing (behavior unchanged), but blueprint phase
   * services and recovery helpers can use it for automatic failure detection.
   */
  onStall?: (stalledMs: number) => void
}

/**
 * Heartbeat / stall detection for executor queries.
 *
 * Sets a periodic timer that checks for activity. When the timer fires
 * and no activity has been recorded, it logs a stall warning.
 * Callers should call `touch()` on each message to reset the activity timer.
 */
export class HeartbeatMonitor {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private lastActivityAt: number = Date.now()
  private _pendingHeartbeat = false
  private readonly stallThresholdMs = 60_000
  private readonly onStall?: (stalledMs: number) => void
  private stallCallbackFired = false

  /** Whether a heartbeat event is pending (timer fired between generator iterations) */
  get pendingHeartbeat(): boolean {
    return this._pendingHeartbeat
  }

  constructor(intervalMsOrOpts: number | HeartbeatMonitorOptions) {
    if (typeof intervalMsOrOpts === 'number') {
      this.intervalMs = intervalMsOrOpts
    } else {
      this.intervalMs = intervalMsOrOpts.intervalMs
      this.onStall = intervalMsOrOpts.onStall
    }
  }

  private intervalMs: number

  /**
   * Start the heartbeat timer. Must be called before the message loop.
   */
  start(): void {
    if (this.intervalMs <= 0) return

    this.lastActivityAt = Date.now()
    this.stallCallbackFired = false
    this.heartbeatTimer = setInterval(() => {
      const stalledMs = Date.now() - this.lastActivityAt
      if (stalledMs > this.stallThresholdMs) {
        // Fire onStall escalation hook once per stall episode
        if (this.onStall && !this.stallCallbackFired) {
          this.stallCallbackFired = true
          try {
            this.onStall(stalledMs)
          } catch (err) {
            executorLog.error('[HeartbeatMonitor] onStall callback threw:', err)
          }
        }

        // Log only every ~60s to reduce noise during expected long waits (MCP tools like Maestro).
        // The stall warning is informational — the keepalive timer keeps the UI alive independently.
        const stalledSec = Math.round(stalledMs / 1000)
        if (stalledSec % 60 < this.intervalMs / 1000) {
          executorLog.warn(`Query appears stalled — no activity for ${stalledSec}s`)
        }
      }
      this._pendingHeartbeat = true
    }, this.intervalMs)
  }

  /**
   * Record activity — call on each message to reset stall detection.
   */
  touch(): void {
    this.lastActivityAt = Date.now()
    this.stallCallbackFired = false
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
