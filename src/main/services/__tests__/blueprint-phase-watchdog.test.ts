/**
 * Unit tests for PhaseActivityWatchdog — stall detection for blueprint phases.
 *
 * Uses short stall timeouts (50-100ms) so timer-based tests complete quickly.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { PhaseActivityWatchdog } from '../blueprint-phase-watchdog'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('PhaseActivityWatchdog', () => {
  test('promise rejects after stallTimeoutMs with no touch()', () =>
    runExclusive(async () => {
      const wd = new PhaseActivityWatchdog(50, 'TEST')
      try {
        await wd.promise
        assert.fail('should have rejected')
      } catch (err) {
        assert.ok(err instanceof Error)
        assert.match(err.message, /TEST phase stalled/)
        assert.equal(wd.stalled, true)
      } finally {
        wd.dispose()
      }
    }))

  test('touch() resets the stall timer — no rejection if activity continues', () =>
    runExclusive(async () => {
      const wd = new PhaseActivityWatchdog(150, 'TEST')
      const promiseP = wd.promise

      // Touch at 40ms, 80ms, 120ms — each resets the 150ms timer
      // Stall would fire at 120 + 150 = 270ms
      await delay(40)
      wd.touch()
      await delay(40)
      wd.touch()
      await delay(40)
      wd.touch()

      // Race: check at ~180ms — well before stall at 270ms
      const result = await Promise.race([
        promiseP.then(() => 'resolved').catch(() => 'rejected'),
        delay(60).then(() => 'survived')
      ])
      assert.equal(result, 'survived')
      assert.equal(wd.stalled, false)
      wd.dispose()
    }))

  test('dispose() prevents stall rejection even after timeout elapses', () =>
    runExclusive(async () => {
      const wd = new PhaseActivityWatchdog(50, 'TEST')
      const promiseP = wd.promise

      // Dispose immediately — should never reject
      wd.dispose()

      const result = await Promise.race([
        promiseP.then(() => 'resolved').catch(() => 'rejected'),
        delay(100).then(() => 'survived')
      ])
      assert.equal(result, 'survived')
    }))

  test('dispose() is idempotent — calling multiple times is safe', () => {
    const wd = new PhaseActivityWatchdog(100, 'TEST')
    wd.dispose()
    wd.dispose()
    wd.dispose()
    // No error thrown
  })

  test('touch() after dispose() is a no-op (no error)', () => {
    const wd = new PhaseActivityWatchdog(100, 'TEST')
    wd.dispose()
    wd.touch() // should not throw
  })

  test('stalled getter is false before timeout', () => {
    const wd = new PhaseActivityWatchdog(100, 'TEST')
    assert.equal(wd.stalled, false)
    wd.dispose()
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
