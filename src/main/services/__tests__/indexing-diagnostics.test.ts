/**
 * Unit tests for indexing-diagnostics.ts — memory checkpoint logger.
 *
 * memoryCheckpoint logs a formatted line via electron-log. We capture the
 * message by swapping log.info on the shared electron-log singleton.
 */
import assert from 'node:assert/strict'
import log from 'electron-log/main'
import { test, describe, summaryAsync } from './test-harness'
import { memoryCheckpoint } from '../indexing-diagnostics'

function capture(fn: () => void): string {
  const original = log.info
  let captured = ''

  ;(log as any).info = (msg: string): void => {
    captured = msg
  }
  try {
    fn()
  } finally {
    ;(log as unknown as { info: typeof original }).info = original
  }
  return captured
}

describe('memoryCheckpoint', () => {
  test('logs the checkpoint name and MB-formatted memory stats', () => {
    const msg = capture(() => memoryCheckpoint('PREPROCESS_START'))
    assert.ok(msg.includes('CHECKPOINT PREPROCESS_START'))
    assert.ok(/rss=\d+\.\d+MB/.test(msg))
    assert.ok(/heap=\d+\.\d+\/\d+\.\d+MB/.test(msg))
    assert.ok(/arraybuf=\d+\.\d+MB/.test(msg))
  })

  test('appends JSON-encoded context when provided', () => {
    const msg = capture(() => memoryCheckpoint('EMBED_BATCH', { batch: 5, phase: 'x' }))
    assert.ok(msg.includes('"batch":5'))
    assert.ok(msg.includes('"phase":"x"'))
  })

  test('omits the context suffix when context is undefined', () => {
    const msg = capture(() => memoryCheckpoint('DONE'))
    // No trailing " | {" JSON segment after the memory stats.
    assert.ok(!msg.includes(' | {'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
