/**
 * Regression tests for the executor pending-tool leak (D4).
 *
 * A tool_result without tool_use_id used to silently no-op consume(), leaving
 * the entry resident forever: pendingToolCount never returned to 0, so
 * cli-executor stayed on the 10-min tool-result timeout branch and the UI kept
 * reporting tools as running with no live child processes behind them.
 *
 * Run via the suite (npm run test:unit) — like its siblings this file needs the
 * electron stub installed by run-tests.ts before the module graph loads.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../__tests__/test-harness'
import { normalizeMessage } from '../stream-normalizer'
import type { StreamState } from '../stream-normalizer'
import { ToolTracker } from '../tool-tracker'
import { TokenAccountant } from '../token-accountant'

function collect(msg: Record<string, unknown>, tools: ToolTracker) {
  const state: StreamState = { streamedTextLength: 0 }
  return [...normalizeMessage(msg, tools, new TokenAccountant(), state, '/workspace')]
}

function toolResult(toolUseId?: string): Record<string, unknown> {
  const block: Record<string, unknown> = { type: 'tool_result', content: 'ok' }
  if (toolUseId) block.tool_use_id = toolUseId
  return { type: 'user', message: { content: [block] } }
}

describe('ToolTracker — consume misses are visible', () => {
  test('consume(undefined) returns false and leaves the map untouched', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    assert.equal(t.consume(undefined), false)
    assert.equal(t.pendingToolCount, 1)
  })

  test('consume of an unknown id returns false', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    assert.equal(t.consume('t-nope'), false)
    assert.equal(t.pendingToolCount, 1)
  })

  test('consume of a tracked id returns true and decrements the count', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    assert.equal(t.consume('t1'), true)
    assert.equal(t.pendingToolCount, 0)
  })

  test('pendingToolNames lists what is still outstanding', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    t.register('t2', 'Read')
    assert.deepEqual(t.pendingToolNames.sort(), ['Bash', 'Read'])
  })

  test('clear() drains every map', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash', 'git fetch', '{"command":"git fetch"}')
    t.register('t2', 'Read')
    t.clear()
    assert.equal(t.pendingToolCount, 0)
    assert.equal(t.resolve('t1'), 'Unknown')
    assert.equal(t.resolveInput('t1'), undefined)
    assert.equal(t.resolveRawInput('t1'), undefined)
  })

  test('sweep() reaps entries older than the cutoff and reports their names', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    const removed = t.sweep(0) // everything registered at/before now
    assert.deepEqual(removed, ['Bash'])
    assert.equal(t.pendingToolCount, 0)
  })

  test('sweep() keeps entries younger than the cutoff', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    assert.deepEqual(t.sweep(60_000), [])
    assert.equal(t.pendingToolCount, 1)
  })

  test('getSolePendingId returns the id only when exactly one is pending', () => {
    const t = new ToolTracker()
    assert.equal(t.getSolePendingId(), undefined)
    t.register('t1', 'Bash')
    assert.equal(t.getSolePendingId(), 't1')
    t.register('t2', 'Read')
    assert.equal(t.getSolePendingId(), undefined)
  })
})

describe('normalizeMessage — tool_result without tool_use_id', () => {
  test('recovers the sole pending tool so the count returns to 0', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash', 'git fetch')
    const chunks = collect(toolResult(), t)
    const result = chunks.find((c) => c.type === 'tool_result')
    assert.equal(result?.toolId, 't1')
    assert.equal(result?.toolName, 'Bash')
    assert.equal(t.pendingToolCount, 0)
  })

  test('does not guess when more than one tool is in flight', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    t.register('t2', 'Read')
    const chunks = collect(toolResult(), t)
    const result = chunks.find((c) => c.type === 'tool_result')
    assert.equal(result?.toolId, undefined)
    // Ambiguous — neither entry is consumed; the executor's end-of-turn
    // clear() is what reaps these.
    assert.equal(t.pendingToolCount, 2)
  })

  test('a normal tool_result still consumes by id', () => {
    const t = new ToolTracker()
    t.register('t1', 'Bash')
    t.register('t2', 'Read')
    collect(toolResult('t2'), t)
    assert.equal(t.pendingToolCount, 1)
    assert.deepEqual(t.pendingToolNames, ['Bash'])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
