/**
 * Unit tests for ToolTracker — maps tool use IDs to tool names and tracks
 * content state for turn boundary detection.
 *
 * Pure class with zero external dependencies — ideal unit test target.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { ToolTracker } from '../executor-utils/tool-tracker'

describe('ToolTracker', () => {
  // ── register + resolve lifecycle ──

  test('resolve returns the registered tool name', () => {
    const t = new ToolTracker()
    t.register('tid-1', 'Read')
    assert.equal(t.resolve('tid-1'), 'Read')
  })

  test('resolve returns "Unknown" for unregistered id', () => {
    const t = new ToolTracker()
    assert.equal(t.resolve('nope'), 'Unknown')
  })

  test('resolve returns "Unknown" for undefined id', () => {
    const t = new ToolTracker()
    assert.equal(t.resolve(undefined), 'Unknown')
  })

  // ── resolveInput ──

  test('resolveInput returns stored input summary', () => {
    const t = new ToolTracker()
    t.register('tid-2', 'Edit', 'src/app.ts')
    assert.equal(t.resolveInput('tid-2'), 'src/app.ts')
  })

  test('resolveInput returns undefined when no input was stored', () => {
    const t = new ToolTracker()
    t.register('tid-3', 'Read')
    assert.equal(t.resolveInput('tid-3'), undefined)
  })

  test('resolveInput returns undefined for undefined id', () => {
    const t = new ToolTracker()
    assert.equal(t.resolveInput(undefined), undefined)
  })

  // ── pendingToolEntries ──

  test('pendingToolEntries exposes id→name pairs for orphan reporting', () => {
    const t = new ToolTracker()
    t.register('tid-a', 'Bash')
    t.register('tid-b', 'mcp__mulldev__test')
    assert.deepEqual(t.pendingToolEntries, [
      ['tid-a', 'Bash'],
      ['tid-b', 'mcp__mulldev__test']
    ])
  })

  test('pendingToolEntries is empty once every call is consumed', () => {
    const t = new ToolTracker()
    t.register('tid-a', 'Bash')
    t.consume('tid-a')
    assert.deepEqual(t.pendingToolEntries, [])
  })

  // ── consume ──

  test('consume removes both name and input mappings', () => {
    const t = new ToolTracker()
    t.register('tid-4', 'Write', '/tmp/out.txt')
    t.consume('tid-4')
    assert.equal(t.resolve('tid-4'), 'Unknown')
    assert.equal(t.resolveInput('tid-4'), undefined)
  })

  test('consume with undefined id is a no-op', () => {
    const t = new ToolTracker()
    t.register('tid-5', 'Bash')
    t.consume(undefined)
    assert.equal(t.resolve('tid-5'), 'Bash')
  })

  // ── registerFromAssistantMessage ──

  test('registerFromAssistantMessage registers tool_use blocks', () => {
    const t = new ToolTracker()
    t.registerFromAssistantMessage([
      { type: 'tool_use', id: 'a1', name: 'Read' },
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'a2', name: 'Write' }
    ])
    assert.equal(t.resolve('a1'), 'Read')
    assert.equal(t.resolve('a2'), 'Write')
  })

  test('registerFromAssistantMessage skips already-tracked tools (dedup)', () => {
    const t = new ToolTracker()
    t.register('a1', 'OriginalTool')
    t.registerFromAssistantMessage([{ type: 'tool_use', id: 'a1', name: 'OverwriteAttempt' }])
    assert.equal(t.resolve('a1'), 'OriginalTool')
  })

  test('registerFromAssistantMessage skips blocks without id', () => {
    const t = new ToolTracker()
    t.registerFromAssistantMessage([{ type: 'tool_use', name: 'NoId' }])
    // Nothing registered — should not throw
    assert.equal(t.resolve('NoId'), 'Unknown')
  })

  // ── state flags ──

  test('initial state flags are correct', () => {
    const t = new ToolTracker()
    assert.equal(t.hasPriorContent, false)
    assert.equal(t.hasPriorText, false)
    assert.equal(t.lastBlockType, null)
    assert.equal(t.currentSchemaName, null)
  })

  test('state flags are mutable', () => {
    const t = new ToolTracker()
    t.hasPriorContent = true
    t.hasPriorText = true
    t.lastBlockType = 'thinking'
    t.currentSchemaName = 'plan_output'
    assert.equal(t.hasPriorContent, true)
    assert.equal(t.hasPriorText, true)
    assert.equal(t.lastBlockType, 'thinking')
    assert.equal(t.currentSchemaName, 'plan_output')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
