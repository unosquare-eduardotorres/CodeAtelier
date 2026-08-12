/**
 * A hand-cranked stand-in for setTimeout/clearTimeout.
 *
 * Satisfies `WatchdogTimers`, so anything that accepts an injected clock can be
 * driven deterministically: `advance(ms)` fires exactly the callbacks whose
 * deadline that many virtual milliseconds would have reached, synchronously and
 * with no real waiting.
 *
 * This exists because "assert the timer did NOT fire" is the worst shape of
 * test to write against real timers — it can only be expressed as "sleep past
 * the threshold and hope", so it measures event-loop contention on a loaded
 * runner rather than the logic under test.
 */
export class ManualClock {
  private now = 0
  private seq = 0
  private readonly scheduled = new Map<number, { at: number; fn: () => void }>()

  /** Virtual milliseconds elapsed since construction. */
  get currentTime(): number {
    return this.now
  }

  /** Number of timers currently outstanding — 0 proves a clean dispose(). */
  get pendingCount(): number {
    return this.scheduled.size
  }

  setTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = ++this.seq
    this.scheduled.set(handle, { at: this.now + ms, fn })
    return handle as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.scheduled.delete(handle as unknown as number)
  }

  /**
   * Move virtual time forward, firing due callbacks in deadline order.
   *
   * Callbacks run as time reaches their deadline (not all at the end), so a
   * callback that schedules another timer behaves the same as it would under
   * real timers.
   */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      let nextHandle: number | null = null
      let nextAt = Infinity
      for (const [handle, entry] of this.scheduled) {
        if (entry.at <= target && entry.at < nextAt) {
          nextAt = entry.at
          nextHandle = handle
        }
      }
      if (nextHandle === null) break
      const entry = this.scheduled.get(nextHandle)!
      this.scheduled.delete(nextHandle)
      this.now = entry.at
      entry.fn()
    }
    this.now = target
  }
}
