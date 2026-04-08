/**
 * Strategy L: Token-bucket rate limiter for parallel SDK calls.
 *
 * Prevents cascading timeouts when multiple specialists fire simultaneously,
 * which can exhaust Claude Max's per-minute rate limit and cause retries.
 *
 * Uses a simple token-bucket algorithm:
 * - Bucket holds `maxTokens` permits (default: 3 concurrent SDK calls)
 * - Each `acquire()` consumes 1 permit
 * - Permits refill at `refillRate` per second
 * - When empty, `acquire()` awaits until a permit is available
 *
 * This is NOT about Claude API tokens — "tokens" here means rate-limit permits.
 */

import { specialistPoolLogger } from '../../logger'

const log = specialistPoolLogger

export class TokenBucketRateLimiter {
  private permits: number
  private lastRefill: number = Date.now()
  private readonly maxPermits: number
  private readonly refillRatePerSecond: number
  private waitQueue: Array<() => void> = []

  /**
   * @param maxPermits Maximum concurrent permits (default: 3 — allows 3 parallel SDK calls)
   * @param refillRatePerSecond How many permits regenerate per second (default: 1)
   */
  constructor(maxPermits: number = 3, refillRatePerSecond: number = 1) {
    this.maxPermits = maxPermits
    this.permits = maxPermits
    this.refillRatePerSecond = refillRatePerSecond
  }

  /**
   * Refills permits based on elapsed time since last refill.
   */
  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    const newPermits = elapsed * this.refillRatePerSecond
    this.permits = Math.min(this.maxPermits, this.permits + newPermits)
    this.lastRefill = now
  }

  /**
   * Acquires a permit, waiting if none are available.
   * Returns a release function that MUST be called when the SDK call completes.
   */
  async acquire(): Promise<() => void> {
    this.refill()

    if (this.permits >= 1) {
      this.permits -= 1
      log.info(
        `[rate-limiter] Permit acquired (${this.permits.toFixed(1)}/${this.maxPermits} remaining)`
      )
      return () => this.release()
    }

    // No permits available — wait for one
    const waitMs = ((1 - this.permits) / this.refillRatePerSecond) * 1000
    log.info(
      `[rate-limiter] No permits available — waiting ~${Math.ceil(waitMs)}ms for next permit`
    )

    return new Promise<() => void>((resolve) => {
      const timer = setTimeout(
        () => {
          this.refill()
          if (this.permits >= 1) {
            this.permits -= 1
            log.info(
              `[rate-limiter] Permit acquired after wait (${this.permits.toFixed(1)}/${this.maxPermits} remaining)`
            )
            resolve(() => this.release())
          } else {
            // Edge case: still no permits — enqueue for next release
            this.waitQueue.push(() => {
              this.permits -= 1
              resolve(() => this.release())
            })
          }
        },
        Math.max(100, waitMs)
      )

      // Clean up timer if a release happens before timeout
      this.waitQueue.push(() => {
        clearTimeout(timer)
        this.permits -= 1
        resolve(() => this.release())
      })
    })
  }

  /**
   * Releases a permit back to the bucket and wakes any waiting acquirers.
   */
  private release(): void {
    this.permits = Math.min(this.maxPermits, this.permits + 1)
    log.info(
      `[rate-limiter] Permit released (${this.permits.toFixed(1)}/${this.maxPermits} available)`
    )

    // Wake up the next waiter, if any
    const waiter = this.waitQueue.shift()
    if (waiter) {
      waiter()
    }
  }
}

/** Singleton rate limiter for specialist SDK calls */
export const specialistRateLimiter = new TokenBucketRateLimiter(3, 1)
