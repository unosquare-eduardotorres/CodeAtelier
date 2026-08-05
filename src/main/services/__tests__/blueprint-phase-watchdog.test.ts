/**
 * Unit tests for PhaseActivityWatchdog — stall detection for blueprint phases.
 *
 * Driven by an injected ManualClock rather than real timers, so "fires at the
 * threshold" and "does NOT fire" are both exact assertions. Previously these
 * slept past short (50-150ms) thresholds and needed runExclusive() to keep the
 * rest of the suite from stealing the event loop mid-measurement.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { PhaseActivityWatchdog } from '../blueprint-phase-watchdog'
import { ManualClock } from './manual-clock'

describe('PhaseActivityWatchdog', () => {
  test('promise rejects after stallTimeoutMs with no touch()', async () => {
    const clock = new ManualClock()
    const wd = new PhaseActivityWatchdog(50, 'TEST', clock)
    const promiseP = wd.promise

    clock.advance(49)
    let settled = false
    void promiseP.catch(() => {
      settled = true
    })
    await Promise.resolve()
    assert.equal(settled, false, 'must not reject one tick early')

    clock.advance(1)
    try {
      await promiseP
      assert.fail('should have rejected')
    } catch (err) {
      assert.ok(err instanceof Error)
      assert.match(err.message, /TEST phase stalled/)
      assert.equal(wd.stalled, true)
    } finally {
      wd.dispose()
    }
  })

  test('touch() resets the stall timer — no rejection if activity continues', async () => {
    const clock = new ManualClock()
    const wd = new PhaseActivityWatchdog(150, 'TEST', clock)
    let rejected = false
    void wd.promise.catch(() => {
      rejected = true
    })

    // Touch at 40ms, 80ms, 120ms — each resets the 150ms timer, so the
    // deadline keeps sliding out to 270ms.
    for (let i = 0; i < 3; i++) {
      clock.advance(40)
      wd.touch()
    }

    // 180ms of virtual time has passed — well past the original 150ms deadline
    // and well before the reset one at 270ms.
    clock.advance(60)
    await Promise.resolve()
    assert.equal(rejected, false)
    assert.equal(wd.stalled, false)

    // And it still fires once activity genuinely stops.
    clock.advance(150)
    await Promise.resolve()
    assert.equal(rejected, true, 'should stall once touches stop')
    wd.dispose()
  })

  test('dispose() prevents stall rejection even after timeout elapses', async () => {
    const clock = new ManualClock()
    const wd = new PhaseActivityWatchdog(50, 'TEST', clock)
    let rejected = false
    void wd.promise.catch(() => {
      rejected = true
    })

    wd.dispose()
    assert.equal(clock.pendingCount, 0, 'dispose() should clear the armed timer')

    clock.advance(1000)
    await Promise.resolve()
    assert.equal(rejected, false)
    assert.equal(wd.stalled, false)
  })

  test('dispose() is idempotent — calling multiple times is safe', () => {
    const wd = new PhaseActivityWatchdog(100, 'TEST', new ManualClock())
    wd.dispose()
    wd.dispose()
    wd.dispose()
    // No error thrown
  })

  test('touch() after dispose() is a no-op (no error)', () => {
    const clock = new ManualClock()
    const wd = new PhaseActivityWatchdog(100, 'TEST', clock)
    wd.dispose()
    wd.touch() // should not throw
    assert.equal(clock.pendingCount, 0, 'touch() after dispose must not re-arm')
  })

  test('stalled getter is false before timeout', () => {
    const wd = new PhaseActivityWatchdog(100, 'TEST', new ManualClock())
    assert.equal(wd.stalled, false)
    wd.dispose()
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
