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
  private readonly intervalMs: number

  constructor(intervalMs: number = TEXT_BATCH_INTERVAL_MS) {
    this.intervalMs = intervalMs
  }

  /**
   * Buffer `text` under `key`. The most recent `flush` callback for a key wins
   * (closures may capture fresh per-chunk context). A timer is armed once per
   * key and fires `flush(buffer)` after the batch interval.
   */
  push(key: string, text: string, flush: (text: string) => void): void {
    this.flushers.set(key, flush)
    this.buffers.set(key, (this.buffers.get(key) ?? '') + text)
    if (!this.timers.has(key)) {
      this.timers.set(
        key,
        setTimeout(() => this.flushKey(key), this.intervalMs)
      )
    }
  }

  /** Flush a single key, or all keys when `key` is omitted. */
  flush(key?: string): void {
    if (key !== undefined) {
      this.flushKey(key)
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
    const buffer = this.buffers.get(key)
    const flusher = this.flushers.get(key)
    if (buffer && flusher) {
      flusher(buffer)
      this.buffers.delete(key)
    }
  }
}
