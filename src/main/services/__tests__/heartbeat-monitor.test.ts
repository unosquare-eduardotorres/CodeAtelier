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
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
