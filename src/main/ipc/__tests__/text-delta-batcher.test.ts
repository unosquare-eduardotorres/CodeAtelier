/**
 * Unit tests for ipc/text-delta-batcher.ts — coalescing, manual flush (single
 * key + all keys), reset semantics, most-recent-flusher-wins, multi-key
 * isolation, and timer-driven auto-flush.
 *
 * Pure logic + a single real-timer test (small interval). No electron deps.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './../../services/__tests__/test-harness'
import { TextDeltaBatcher, TEXT_BATCH_INTERVAL_MS } from '../text-delta-batcher'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('TextDeltaBatcher › coalescing + manual flush', () => {
  test('coalesces multiple pushes under one key into a single flush', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const flush = createSpy<[string], void>()
    batcher.push('c1', 'Hello ', flush)
    batcher.push('c1', 'world', flush)
    assert.equal(flush.callCount, 0, 'no flush before timer/manual')

    batcher.flush('c1')
    assert.equal(flush.callCount, 1)
    assert.deepEqual(flush.lastCall, ['Hello world'])
  })

  test('flush(key) clears the buffer — a second flush is a no-op', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const flush = createSpy<[string], void>()
    batcher.push('c1', 'abc', flush)
    batcher.flush('c1')
    batcher.flush('c1')
    assert.equal(flush.callCount, 1)
  })

  test('flush() with no key flushes every key', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const f1 = createSpy<[string], void>()
    const f2 = createSpy<[string], void>()
    batcher.push('a', 'one', f1)
    batcher.push('b', 'two', f2)
    batcher.flush()
    assert.deepEqual(f1.lastCall, ['one'])
    assert.deepEqual(f2.lastCall, ['two'])
  })

  test('does not flush a key with no buffered text', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const flush = createSpy<[string], void>()
    batcher.flush('never-pushed')
    assert.equal(flush.callCount, 0)
  })
})

describe('TextDeltaBatcher › flusher semantics', () => {
  test('most-recent flusher for a key wins', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const oldFlush = createSpy<[string], void>()
    const newFlush = createSpy<[string], void>()
    batcher.push('c1', 'a', oldFlush)
    batcher.push('c1', 'b', newFlush)
    batcher.flush('c1')
    assert.equal(oldFlush.callCount, 0)
    assert.equal(newFlush.callCount, 1)
    assert.deepEqual(newFlush.lastCall, ['ab'])
  })

  test('multi-key isolation — no cross-stream mixing', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const fa = createSpy<[string], void>()
    const fb = createSpy<[string], void>()
    batcher.push('conv-a', 'AAA', fa)
    batcher.push('conv-b', 'BBB', fb)
    batcher.push('conv-a', '111', fa)
    batcher.flush()
    assert.deepEqual(fa.lastCall, ['AAA111'])
    assert.deepEqual(fb.lastCall, ['BBB'])
  })
})

describe('TextDeltaBatcher › reset', () => {
  test('reset(key) flushes then drops the flusher so it cannot fire again', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const flush = createSpy<[string], void>()
    batcher.push('c1', 'final', flush)
    batcher.reset('c1')
    assert.equal(flush.callCount, 1, 'reset flushes pending buffer')

    // After reset the flusher is gone — a fresh push needs a new flusher.
    batcher.push('c1', 'more', flush)
    batcher.flush('c1')
    assert.equal(flush.callCount, 2)
  })

  test('reset() with no key flushes all and clears every flusher', () => {
    const batcher = new TextDeltaBatcher(10_000)
    const f1 = createSpy<[string], void>()
    const f2 = createSpy<[string], void>()
    batcher.push('a', 'x', f1)
    batcher.push('b', 'y', f2)
    batcher.reset()
    assert.equal(f1.callCount, 1)
    assert.equal(f2.callCount, 1)
  })
})

describe('TextDeltaBatcher › timer auto-flush', () => {
  test('default interval constant is one 30fps frame', () => {
    assert.equal(TEXT_BATCH_INTERVAL_MS, 33)
  })

  test('auto-flushes after the batch interval elapses', async () => {
    const batcher = new TextDeltaBatcher(5)
    const flush = createSpy<[string], void>()
    batcher.push('c1', 'auto', flush)
    assert.equal(flush.callCount, 0)
    await delay(25)
    assert.equal(flush.callCount, 1)
    assert.deepEqual(flush.lastCall, ['auto'])
  })

  test('only one timer is armed per key across rapid pushes', async () => {
    const batcher = new TextDeltaBatcher(5)
    const flush = createSpy<[string], void>()
    batcher.push('c1', 'a', flush)
    batcher.push('c1', 'b', flush)
    batcher.push('c1', 'c', flush)
    await delay(25)
    assert.equal(flush.callCount, 1, 'coalesced into a single timer-driven flush')
    assert.deepEqual(flush.lastCall, ['abc'])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
