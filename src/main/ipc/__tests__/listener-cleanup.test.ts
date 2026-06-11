/**
 * Unit tests for ipc/listener-cleanup.ts — per-workspace listener lifecycle
 * with timed auto-cleanup safety net.
 *
 * Mocks EventEmitterLike with createSpy. Uses short timeouts (10-20ms) for
 * the auto-cleanup timer tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from '../../services/__tests__/test-harness'
import { createTimedCleanupMap } from '../listener-cleanup'

/** Minimal EventEmitterLike mock */
function mockEmitter() {
  return {
    on: createSpy<[string, (...args: unknown[]) => void], void>(),
    off: createSpy<[string, (...args: unknown[]) => void], void>()
  }
}

describe('createTimedCleanupMap — prepareCleanups', () => {
  test('creates a fresh cleanup array for a new workspace', () => {
    const map = createTimedCleanupMap('test')
    const cleanups = map.prepareCleanups('ws-1')
    assert.ok(Array.isArray(cleanups))
    assert.equal(cleanups.length, 0)
  })

  test('calling twice on same workspaceId runs stale cleanups first', () => {
    const map = createTimedCleanupMap('test')
    const emitter = mockEmitter()
    const cleanups1 = map.prepareCleanups('ws-dup')

    // Add a listener to the first batch
    const handler = (): void => {}
    map.addListener(cleanups1, emitter, 'event-a', handler)
    assert.equal(emitter.on.callCount, 1)

    // Prepare again — should run stale cleanup (calling emitter.off)
    const cleanups2 = map.prepareCleanups('ws-dup')
    assert.equal(emitter.off.callCount, 1, 'stale cleanup should have called off()')
    assert.equal(cleanups2.length, 0, 'new cleanup array should be empty')
  })
})

describe('createTimedCleanupMap — addListener', () => {
  test('calls emitter.on() and pushes a cleanup fn', () => {
    const map = createTimedCleanupMap('test')
    const emitter = mockEmitter()
    const cleanups = map.prepareCleanups('ws-add')
    const handler = (): void => {}

    map.addListener(cleanups, emitter, 'data', handler)
    assert.equal(emitter.on.callCount, 1)
    assert.equal(emitter.on.lastCall![0], 'data')
    assert.equal(cleanups.length, 1)

    // Running the cleanup should call emitter.off
    cleanups[0]()
    assert.equal(emitter.off.callCount, 1)
    assert.equal(emitter.off.lastCall![0], 'data')
  })
})

describe('createTimedCleanupMap — runCleanup', () => {
  test('runs all cleanup fns and deletes from map', () => {
    const map = createTimedCleanupMap('test')
    const emitter = mockEmitter()
    const cleanups = map.prepareCleanups('ws-run')
    map.addListener(cleanups, emitter, 'ev1', () => {})
    map.addListener(cleanups, emitter, 'ev2', () => {})

    map.runCleanup('ws-run')
    assert.equal(emitter.off.callCount, 2, 'both listeners should be cleaned up')

    // Second call is a no-op (already deleted)
    map.runCleanup('ws-run')
    assert.equal(emitter.off.callCount, 2, 'no additional calls')
  })

  test('runCleanup on unknown workspace is a no-op', () => {
    const map = createTimedCleanupMap('test')
    // Should not throw
    map.runCleanup('nonexistent')
  })
})

describe('createTimedCleanupMap — scheduleAutoCleanup', () => {
  test('auto-cleanup fires after timeout and cleans listeners', async () => {
    const map = createTimedCleanupMap('test')
    const emitter = mockEmitter()
    const cleanups = map.prepareCleanups('ws-auto')
    map.addListener(cleanups, emitter, 'ev1', () => {})

    map.scheduleAutoCleanup('ws-auto', cleanups, 15) // 15ms

    // Before timer fires, off should not have been called (except via auto-cleanup)
    await new Promise((r) => setTimeout(r, 30))
    // The auto-cleanup should have called off for ev1, plus clearTimeout cleanup
    assert.ok(emitter.off.callCount >= 1, 'auto-cleanup should have fired')
  })

  test('manual runCleanup cancels the auto-cleanup timer', async () => {
    const map = createTimedCleanupMap('test')
    const emitter = mockEmitter()
    const cleanups = map.prepareCleanups('ws-cancel')
    map.addListener(cleanups, emitter, 'ev1', () => {})
    map.scheduleAutoCleanup('ws-cancel', cleanups, 15)

    // Run cleanup manually before the timer fires
    map.runCleanup('ws-cancel')
    const offCountAfterManual = emitter.off.callCount

    // Wait past the auto-cleanup timeout
    await new Promise((r) => setTimeout(r, 30))
    // off count should not have increased (timer was canceled)
    assert.equal(emitter.off.callCount, offCountAfterManual, 'timer should have been cancelled by manual cleanup')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
