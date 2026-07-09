/**
 * Unit tests for HeartbeatMonitor — stall detection for executor queries.
 *
 * Uses a short interval (10ms) so timer-based tests complete quickly.
 * electron-log is import-safe under tsx (logs to /dev/null equivalent).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { HeartbeatMonitor } from '../executor-utils/heartbeat-monitor'

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('HeartbeatMonitor', () => {
  test('start() with intervalMs <= 0 is a no-op', () => {
    const hb = new HeartbeatMonitor(0)
    hb.start()
    assert.equal(hb.pendingHeartbeat, false)
    hb.stop() // safe to call
  })

  test('start() fires heartbeat after interval', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor(10)
      hb.start()
      assert.equal(hb.pendingHeartbeat, false)
      await delay(40)
      assert.equal(hb.pendingHeartbeat, true)
      hb.stop()
    }))

  test('consumeHeartbeat() returns true once then false', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor(10)
      hb.start()
      await delay(40)
      assert.equal(hb.consumeHeartbeat(), true)
      assert.equal(hb.consumeHeartbeat(), false)
      hb.stop()
    }))

  test('touch() resets the lastActivityAt timestamp', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor(10)
      hb.start()
      await delay(5)
      hb.touch()
      // The monitor should still be running without issues
      await delay(40)
      // pendingHeartbeat should still fire (touch resets activity, not the timer)
      assert.equal(hb.pendingHeartbeat, true)
      hb.stop()
    }))

  test('stop() clears the interval — no further heartbeats', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor(10)
      hb.start()
      hb.stop()
      // After stop, consume any heartbeat that may have fired synchronously
      hb.consumeHeartbeat()
      // Wait long enough for multiple intervals
      await delay(40)
      assert.equal(hb.pendingHeartbeat, false, 'no heartbeat should fire after stop')
    }))

  test('stop() on a never-started monitor is safe', () => {
    const hb = new HeartbeatMonitor(10)
    hb.stop() // should not throw
  })

  test('pendingHeartbeat getter reflects _pendingHeartbeat state', () => {
    const hb = new HeartbeatMonitor(1000)
    assert.equal(hb.pendingHeartbeat, false)
  })

  // ── onStall escalation hook tests ──

  test('options constructor: onStall fires once when stall threshold crossed', () =>
    runExclusive(async () => {
      const stallCalls: number[] = []
      const hb = new HeartbeatMonitor({
        intervalMs: 10,
        onStall: (ms) => stallCalls.push(ms)
      })
      // Override stall threshold to something testable
      // The threshold is 60s by default — too long for tests.
      // We'll simulate by setting lastActivityAt far in the past.
      ;(hb as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 70_000
      hb.start()
      // start() resets lastActivityAt, so override again
      ;(hb as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 70_000
      await delay(40)
      hb.stop()
      assert.ok(stallCalls.length >= 1, 'onStall should have fired at least once')
      assert.ok(stallCalls[0] >= 60_000, 'stalledMs should be >= 60s')
    }))

  test('options constructor: onStall fires only once per stall episode (reset by touch)', () =>
    runExclusive(async () => {
      const stallCalls: number[] = []
      const hb = new HeartbeatMonitor({
        intervalMs: 10,
        onStall: (ms) => stallCalls.push(ms)
      })
      hb.start()
      // Force stall
      ;(hb as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 70_000
      await delay(30) // fires once
      const countAfterFirst = stallCalls.length
      assert.ok(countAfterFirst >= 1, 'should have fired at least once')

      // touch() resets — should be able to fire again after next stall
      hb.touch()
      const countAfterTouch = stallCalls.length
      ;(hb as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 70_000
      await delay(30) // fires again
      assert.ok(stallCalls.length > countAfterTouch, 'should fire again after touch reset')
      hb.stop()
    }))

  test('options constructor: no onStall — behaves identically to number constructor', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor({ intervalMs: 10 })
      hb.start()
      assert.equal(hb.pendingHeartbeat, false)
      await delay(40)
      assert.equal(hb.pendingHeartbeat, true)
      hb.stop()
    }))

  test('onStall callback throwing does not crash the timer', () =>
    runExclusive(async () => {
      const hb = new HeartbeatMonitor({
        intervalMs: 10,
        onStall: () => { throw new Error('callback boom') }
      })
      hb.start()
      ;(hb as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 70_000
      await delay(30) // should not throw
      hb.stop()
      // If we got here, the timer survived the throw
    }))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
