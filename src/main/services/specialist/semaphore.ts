/**
 * Async semaphore for controlling concurrent specialist execution.
 * Replaces manual concurrency tracking in SpecialistPoolService.
 *
 * Usage:
 *   const sem = new Semaphore(4)
 *   const release = await sem.acquire()
 *   try { await doWork() } finally { release() }
 */
export class Semaphore {
  private current = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly maxConcurrency: number) {
    if (maxConcurrency < 1) throw new Error('Semaphore maxConcurrency must be >= 1')
  }

  /**
   * Acquire a slot. Resolves immediately if under the limit,
   * otherwise queues and resolves when a slot opens.
   * Returns a release function that MUST be called when done.
   */
  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const tryAcquire = (): void => {
        if (this.current < this.maxConcurrency) {
          this.current++
          resolve(this.createRelease())
        } else {
          this.queue.push(tryAcquire)
        }
      }
      tryAcquire()
    })
  }

  private createRelease(): () => void {
    let released = false
    return (): void => {
      if (released) return // idempotent — double-release is safe
      released = true
      this.current--
      if (this.queue.length > 0) {
        const next = this.queue.shift()!
        next()
      }
    }
  }

  /**
   * Run `fn` while holding one slot. Automatically releases on success,
   * error, or abort — eliminates manual release() tracking.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** Drain all queued waiters without resolving them (for abort scenarios) */
  drain(): void {
    this.queue.length = 0
  }
}
