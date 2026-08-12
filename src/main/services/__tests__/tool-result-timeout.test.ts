/**
 * Unit tests for the ToolTracker surface that cli-executor's read-timeout
 * branching depends on.
 *
 * cli-executor picks one of three waits per read: untimed when a human-input
 * tool is pending, TOOL_RESULT_TIMEOUT_MS (10min) when any other tool is
 * pending, MESSAGE_TIMEOUT_MS (5min) when none is. pendingToolCount and
 * hasAskUserPending() are the two inputs to that choice, so they are what this
 * file pins down.
 *
 * This file previously asserted getToolName() and allPendingAreAskUser().
 * Neither has existed on ToolTracker at any commit — the file was never
 * registered in run-tests.ts, so the failures were never surfaced. Rewritten
 * against resolve() and hasAskUserPending(), which are what actually ship.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

const { ToolTracker, stripMcpNamespace } = require('../executor-utils/tool-tracker') as any

describe('stripMcpNamespace', () => {
  test('strips the mcp__<server>__ prefix', () => {
    assert.equal(stripMcpNamespace('mcp__control-actions__ask_user'), 'ask_user')
  })

  test('handles server names containing hyphens and tools containing underscores', () => {
    assert.equal(
      stripMcpNamespace('mcp__control-actions__emit_phase_progress'),
      'emit_phase_progress'
    )
    assert.equal(stripMcpNamespace('mcp__file-tools__Read'), 'Read')
  })

  test('leaves built-in (non-MCP) tool names untouched', () => {
    assert.equal(stripMcpNamespace('Edit'), 'Edit')
    assert.equal(stripMcpNamespace('Bash'), 'Bash')
    assert.equal(stripMcpNamespace('ask_user'), 'ask_user')
  })

  test('leaves a malformed mcp name with no second separator untouched', () => {
    assert.equal(stripMcpNamespace('mcp__weird'), 'mcp__weird')
  })
})

describe('ToolTracker — resolve', () => {
  test('returns the name for a registered tool', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__code-graph__FindSymbol')
    assert.equal(tracker.resolve('tool-1'), 'mcp__code-graph__FindSymbol')
  })

  test("returns 'Unknown' for an unregistered id", () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.resolve('nonexistent'), 'Unknown')
  })

  test("returns 'Unknown' for an undefined id", () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.resolve(undefined), 'Unknown')
  })

  test("returns 'Unknown' after consume", () => {
    const tracker = new ToolTracker()
    tracker.register('tool-2', 'mcp__file-tools__Read')
    tracker.consume('tool-2')
    assert.equal(tracker.resolve('tool-2'), 'Unknown')
  })
})

describe('ToolTracker — hasAskUserPending', () => {
  test('no pending tools → false', () => {
    const tracker = new ToolTracker()
    assert.equal(tracker.hasAskUserPending(), false)
  })

  // Regression: ask_user is only reachable over MCP, so the stream always
  // registers it fully qualified. Matching the bare name made cli-executor's
  // untimed human-input branch dead code and put every ask_user wait on the
  // 10-minute tool-result timeout instead.
  test('fully-qualified MCP ask_user is recognised', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    assert.equal(tracker.hasAskUserPending(), true)
  })

  test('bare ask_user is still recognised', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'ask_user')
    assert.equal(tracker.hasAskUserPending(), true)
  })

  test('single non-ask_user pending → false', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__code-graph__FindSymbol')
    assert.equal(tracker.hasAskUserPending(), false)
  })

  // "has ... pending" is an ANY predicate, not an ALL one: a mixed batch still
  // contains a human wait, so the turn must not be put on a wall clock.
  test('mixed ask_user + non-ask_user → true', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.register('tool-2', 'mcp__file-tools__Read')
    assert.equal(tracker.hasAskUserPending(), true)
  })

  test('goes false again once the ask_user result is consumed', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__ask_user')
    tracker.register('tool-2', 'mcp__file-tools__Write')
    tracker.consume('tool-1')
    assert.equal(tracker.hasAskUserPending(), false)
    assert.equal(tracker.pendingToolCount, 1)
  })

  test('emit_plan is not treated as a human wait', () => {
    const tracker = new ToolTracker()
    tracker.register('tool-1', 'mcp__control-actions__emit_plan')
    assert.equal(tracker.hasAskUserPending(), false)
  })
})

describe('ToolTracker — pendingToolCount with timeout interactions', () => {
  test('increments on register, decrements on consume', () => {
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

  test('consume reports whether anything was actually removed', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'tool-a')
    assert.equal(tracker.consume('t1'), true)
    // A miss must be visible to callers: it pins pendingToolCount above zero
    // and keeps the executor on the tool-result branch forever.
    assert.equal(tracker.consume('t1'), false)
    assert.equal(tracker.consume(undefined), false)
  })

  test('multiple tools: stale detection scenario', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'mcp__code-graph__FindSymbol')
    tracker.register('t2', 'mcp__file-tools__Bash')

    assert.equal(tracker.hasAskUserPending(), false)

    tracker.consume('t1')
    assert.equal(tracker.pendingToolCount, 1)
    assert.equal(tracker.hasAskUserPending(), false)
  })
})

describe('ToolTracker — backfillInput', () => {
  test('fills input for an id registered without one', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'Edit')
    tracker.backfillInput('t1', 'src/a.ts (1 edit)', '{"file_path":"src/a.ts"}')
    assert.equal(tracker.resolveInput('t1'), 'src/a.ts (1 edit)')
    assert.equal(tracker.resolveRawInput('t1'), '{"file_path":"src/a.ts"}')
  })

  test('does not overwrite an input the streaming path already captured', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'Edit', 'streamed', '{"file_path":"streamed.ts"}')
    tracker.backfillInput('t1', 'replay', '{"file_path":"replay.ts"}')
    assert.equal(tracker.resolveInput('t1'), 'streamed')
    assert.equal(tracker.resolveRawInput('t1'), '{"file_path":"streamed.ts"}')
  })

  test('undefined values are no-ops', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'Edit')
    tracker.backfillInput('t1', undefined, undefined)
    assert.equal(tracker.resolveInput('t1'), undefined)
    assert.equal(tracker.resolveRawInput('t1'), undefined)
  })

  test('consume clears backfilled input', () => {
    const tracker = new ToolTracker()
    tracker.register('t1', 'Edit')
    tracker.backfillInput('t1', 'summary', '{}')
    tracker.consume('t1')
    assert.equal(tracker.resolveRawInput('t1'), undefined)
  })
})

// ─── Guardian: run summary only when standalone ───
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
