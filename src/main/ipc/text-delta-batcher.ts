/**
 * TextDeltaBatcher — coalesces streaming text deltas and flushes them at ~30fps.
 *
 * Shared by every streaming surface (Chat via chunk-router, Grill, Council) so
 * the renderer receives smooth sentence-cadence text instead of a burst of tiny
 * IPC sends. Reduces IPC calls from ~15/sec to ~3-5/sec during fast streaming.
 *
 * Generic by design: the caller supplies a `key` (to keep concurrent streams —
 * conversations, workspaces, advisors — from mixing) and a `flush` callback that
 * actually delivers the accumulated text. The batcher owns only the timing.
 */

/** One frame at 30fps. */
export const TEXT_BATCH_INTERVAL_MS = 33

export class TextDeltaBatcher {
  private buffers = new Map<string, string>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private flushers = new Map<string, (text: string) => void>()
  /** Per-key active interval — tracks what interval each key's timer was armed with. */
  private activeIntervals = new Map<string, number>()
  private readonly intervalMs: number

  constructor(intervalMs: number = TEXT_BATCH_INTERVAL_MS) {
    this.intervalMs = intervalMs
  }

  /**
   * Buffer `text` under `key`. The most recent `flush` callback for a key wins
   * (closures may capture fresh per-chunk context). A timer is armed once per
   * key and fires `flush(buffer)` after the batch interval.
   *
   * @param intervalOverride — optional per-push interval override (ms). When the
   *   recommended interval changes (e.g. due to backpressure), the pending timer
   *   is rescheduled to the new interval. Omit to use the constructor default.
   */
  push(key: string, text: string, flush: (text: string) => void, intervalOverride?: number): void {
    this.flushers.set(key, flush)
    this.buffers.set(key, (this.buffers.get(key) ?? '') + text)
    const interval = intervalOverride ?? this.intervalMs
    const activeInterval = this.activeIntervals.get(key)

    if (!this.timers.has(key)) {
      // No pending timer — arm a new one
      this.activeIntervals.set(key, interval)
      this.timers.set(
        key,
        setTimeout(() => this.flushKey(key), interval)
      )
    } else if (activeInterval !== undefined && interval > activeInterval) {
      // IPC-BACKPRESSURE: Backpressure increased — reschedule with longer interval.
      // Only reschedule when slowing down (interval > active), not when speeding up,
      // to avoid cancelling a timer that's about to fire.
      clearTimeout(this.timers.get(key)!)
      this.activeIntervals.set(key, interval)
      this.timers.set(
        key,
        setTimeout(() => this.flushKey(key), interval)
      )
    }
  }

  /** Flush a single key, or all keys when `key` is omitted. */
  flush(key?: string): void {
    if (key !== undefined) {
      this.flushKey(key)
      // BATCHER-FLUSH-RETAINS-FLUSHER-01: Clear flusher after flush to prevent
      // stale callbacks (capturing old ctx/mainWindow) from firing on reuse.
      this.flushers.delete(key)
      return
    }
    for (const k of [...this.buffers.keys()]) {
      this.flushKey(k)
    }
  }

  /**
   * Flush and forget the flusher(s) — call at stream end so a key doesn't retain
   * a stale callback. With no `key`, resets everything.
   */
  reset(key?: string): void {
    if (key !== undefined) {
      this.flushKey(key)
      this.flushers.delete(key)
      return
    }
    this.flush()
    this.flushers.clear()
  }

  private flushKey(key: string): void {
    const timer = this.timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(key)
    }
    this.activeIntervals.delete(key)
    const buffer = this.buffers.get(key)
    const flusher = this.flushers.get(key)
    if (buffer && flusher) {
      try {
        flusher(buffer)
      } catch (err) {
        // All current callers use safeSend-wrapped callbacks, but the batcher
        // is a shared primitive — guard against future flusher regressions.
        if (typeof console !== 'undefined') console.warn('[TextDeltaBatcher] Flush error:', err)
      }
      this.buffers.delete(key)
    }
  }
}
