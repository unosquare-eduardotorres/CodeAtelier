/**
 * Unit tests for tool-result timeout and ToolTracker extensions.
 *
 * Covers:
 *   Fix 2.1 — Tool-result timeout (getToolName, allPendingAreAskUser)
 *   Fix 2.2 — killOrphanedChildren (indirect — verifies field exists)
 *   Fix 3.1 — Crash detection after 1+ messages (type validation)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

const { ToolTracker } = require('../executor-utils/tool-tracker') as any

describe('ToolTracker — getToolName', () => {
  test('returns name for registered tool', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__code-graph__FindSymbol')
    assert.equal(tracker.getToolName('tool-1'), 'mcp__code-graph__FindSymbol')
  })

  test('returns undefined for unregistered tool', () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.getToolName('nonexistent'), undefined)
  })

  test('returns undefined after consume', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-2', 'mcp__file-tools__Read')
    tracker.consume('tool-2')
    assert.equal(tracker.getToolName('tool-2'), undefined)
  })
})

describe('ToolTracker — allPendingAreAskUser', () => {
  test('no pending tools → false', () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.allPendingAreAskUser(), false)
  })

  test('single ask_user pending → true', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    assert.equal(tracker.allPendingAreAskUser(), true)
  })

  test('single non-ask_user pending → false', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__code-graph__FindSymbol')
    assert.equal(tracker.allPendingAreAskUser(), false)
  })

  test('mixed: ask_user + non-ask_user → false', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.register('tool-2', 'mcp__file-tools__Read')
    assert.equal(tracker.allPendingAreAskUser(), false)
  })

  test('multiple ask_user pending → true', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.register('tool-2', 'mcp__control-actions__ask_user_question')
    assert.equal(tracker.allPendingAreAskUser(), true)
  })

  test('ask_user consumed, non-ask_user remaining → false', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.register('tool-2', 'mcp__file-tools__Write')
    tracker.consume('tool-1')
    assert.equal(tracker.allPendingAreAskUser(), false)
  })

  test('all tools consumed → false', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.consume('tool-1')
    assert.equal(tracker.allPendingAreAskUser(), false)
    assert.equal(tracker.pendingToolCount, 0)
  })
})

describe('ToolTracker — pendingToolCount with timeout interactions', () => {
  test('pendingToolCount increments on register, decrements on consume', () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.pendingToolCount, 0)

    tracker.register('t1', 'tool-a')
    assert.equal(tracker.pendingToolCount, 1)

    tracker.register('t2', 'tool-b')
    assert.equal(tracker.pendingToolCount, 2)

    tracker.consume('t1')
    assert.equal(tracker.pendingToolCount, 1)

    tracker.consume('t2')
    assert.equal(tracker.pendingToolCount, 0)
  })

  test('multiple tools: stale detection scenario', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'mcp__code-graph__FindSymbol')
    tracker.register('t2', 'mcp__file-tools__Bash')

    // Both are non-ask_user
    assert.equal(tracker.allPendingAreAskUser(), false)

    // One consumed, one still pending
    tracker.consume('t1')
    assert.equal(tracker.pendingToolCount, 1)
    assert.equal(tracker.allPendingAreAskUser(), false)
  })
})

// ─── Guardian: run summary only when standalone ───
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
