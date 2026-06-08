/**
 * Unit tests for AuditCoverageTracker — tracks file-level coverage during
 * audit execution by extracting file paths from tool_use / tool_result chunks.
 *
 * Pure class, no external dependencies. Each test creates its own tracker
 * instance to avoid state leakage.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AuditCoverageTracker } from '../audit-coverage-tracker'
import type { StreamChunk } from '../agent-base.service'

describe('AuditCoverageTracker', () => {
  // ── tool_use with JSON input (SDK format) ──

  test('extracts file_path from JSON tool input', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Read',
      toolInput: JSON.stringify({ file_path: 'src/main/index.ts' })
    } as StreamChunk)
    const stats = tracker.getStats()
    assert.equal(stats.fileCount, 1)
    assert.ok(stats.filesInspected.includes('src/main/index.ts'))
    assert.equal(stats.toolCallCount, 1)
    assert.equal(stats.readToolCount, 1)
  })

  test('extracts path field from JSON tool input', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Grep',
      toolInput: JSON.stringify({ path: 'src/main', pattern: 'foo' })
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main'))
  })

  // ── tool_use with display string (CLI format) ──

  test('extracts file path from Read display string (no spaces)', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Read',
      toolInput: 'src/main/app.ts'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main/app.ts'))
  })

  test('extracts file path from Write display string', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Write',
      toolInput: 'src/output.json'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/output.json'))
  })

  test('extracts file path from Edit display string', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Edit',
      toolInput: 'src/utils.ts'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/utils.ts'))
  })

  test('extracts path from "outline:" prefix pattern', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'file_outline',
      toolInput: 'outline: src/main/index.ts'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main/index.ts'))
  })

  test('extracts path from "deps:" prefix pattern', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'module_dependencies',
      toolInput: 'deps: src/main/service.ts'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main/service.ts'))
  })

  test('extracts path from Grep "in path" pattern', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Grep',
      toolInput: '/pattern/ in src/main'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main'))
  })

  test('non-file tools just increment toolCallCount', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'SomeUnknownTool',
      toolInput: 'whatever'
    } as StreamChunk)
    assert.equal(tracker.getStats().toolCallCount, 1)
    assert.equal(tracker.getStats().readToolCount, 0)
    assert.equal(tracker.getStats().fileCount, 0)
  })

  test('increments readToolCount for known read tools', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'find_references',
      toolInput: 'some input'
    } as StreamChunk)
    assert.equal(tracker.getStats().readToolCount, 1)
  })

  test('increments readToolCount for MCP-prefixed code-graph tools', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'mcp__code-graph__file_outline'
    } as StreamChunk)
    assert.equal(tracker.getStats().readToolCount, 1)
  })

  // ── tool_result — file path extraction from Glob/Grep results ──

  test('extracts file paths from Glob result lines', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_result',
      toolName: 'Glob',
      content: 'src/main/index.ts\nsrc/main/app.ts\n'
    } as StreamChunk)
    const stats = tracker.getStats()
    assert.equal(stats.fileCount, 2)
    assert.ok(stats.filesInspected.includes('src/main/index.ts'))
    assert.ok(stats.filesInspected.includes('src/main/app.ts'))
  })

  test('extracts file paths from Grep result lines', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_result',
      toolName: 'Grep',
      content: 'src/utils.ts\nsrc/helper.js'
    } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 2)
  })

  test('skips lines that do not look like file paths', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_result',
      toolName: 'Glob',
      content: 'src/main/index.ts\nsome random text\n3 matches found'
    } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 1)
  })

  test('ignores tool_result with no content', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({ type: 'tool_result', toolName: 'Glob' } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 0)
  })

  test('ignores tool_result from non-Glob/Grep tools', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_result',
      toolName: 'Read',
      content: 'src/main/index.ts'
    } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 0)
  })

  // ── normalizePath ──

  test('normalizePath strips leading ./ prefix', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use',
      toolName: 'Read',
      toolInput: './src/main/index.ts'
    } as StreamChunk)
    assert.ok(tracker.getStats().filesInspected.includes('src/main/index.ts'))
  })

  // ── dedup ──

  test('deduplicates file paths', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use', toolName: 'Read', toolInput: 'src/app.ts'
    } as StreamChunk)
    tracker.onChunk({
      type: 'tool_use', toolName: 'Read', toolInput: 'src/app.ts'
    } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 1)
    assert.equal(tracker.getStats().toolCallCount, 2)
  })

  // ── getStats shape ──

  test('getStats returns correct shape', () => {
    const tracker = new AuditCoverageTracker()
    const stats = tracker.getStats()
    assert.ok(Array.isArray(stats.filesInspected))
    assert.equal(typeof stats.fileCount, 'number')
    assert.equal(typeof stats.toolCallCount, 'number')
    assert.equal(typeof stats.readToolCount, 'number')
  })

  // ── reset ──

  test('reset clears all tracking state', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({
      type: 'tool_use', toolName: 'Read', toolInput: 'src/app.ts'
    } as StreamChunk)
    tracker.reset()
    const stats = tracker.getStats()
    assert.equal(stats.fileCount, 0)
    assert.equal(stats.toolCallCount, 0)
    assert.equal(stats.readToolCount, 0)
    assert.deepEqual(stats.filesInspected, [])
  })

  // ── no toolInput ──

  test('handles tool_use with no toolInput gracefully', () => {
    const tracker = new AuditCoverageTracker()
    tracker.onChunk({ type: 'tool_use', toolName: 'Read' } as StreamChunk)
    assert.equal(tracker.getStats().fileCount, 0)
    assert.equal(tracker.getStats().toolCallCount, 1)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
