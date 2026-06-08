/**
 * Unit tests for tool-activity-accumulator.ts — tracks tool calls, explored
 * files, discovery summaries, and estimated token consumption per exchange.
 *
 * Pure logic — no Electron deps — runs from the main-process harness.
 *
 * Coverage:
 *  - record + getExploredFiles dedup; file-path extraction from raw object inputs
 *    (file_path / filePath / Glob+Grep path) and summarized string inputs.
 *  - buildDiscoverySummary (empty, normal, char-cap truncation, top-tools).
 *  - getEstimatedTokensConsumed (chars / 3.5 ceil).
 *  - count / getEntries / reset.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { ToolActivityAccumulator } from '../tool-activity-accumulator'

describe('ToolActivityAccumulator — record + file extraction', () => {
  test('extracts file_path from a raw object input', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: { file_path: 'src/a.ts' }, outputLength: 100 })
    assert.deepEqual(acc.getExploredFiles(), ['src/a.ts'])
  })

  test('extracts filePath (camelCase) variant', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'FileOutline', input: { filePath: 'src/b.ts' }, outputLength: 10 })
    assert.deepEqual(acc.getExploredFiles(), ['src/b.ts'])
  })

  test('extracts Glob/Grep path parameter', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Glob', input: { path: 'src/dir' }, outputLength: 5 })
    acc.record({ toolName: 'Grep', input: { path: 'src/other' }, outputLength: 5 })
    assert.deepEqual(acc.getExploredFiles().sort(), ['src/dir', 'src/other'])
  })

  test('extracts path from a summarized string input (slash, no space)', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: 'src/main/foo.ts', outputLength: 1 })
    assert.deepEqual(acc.getExploredFiles(), ['src/main/foo.ts'])
  })

  test('extracts path after " in " from a Grep summary string', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Grep', input: '/pattern/ in src/services', outputLength: 1 })
    assert.deepEqual(acc.getExploredFiles(), ['src/services'])
  })

  test('no file path recorded for inputs without one', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Bash', input: { command: 'ls' }, outputLength: 1 })
    assert.deepEqual(acc.getExploredFiles(), [])
  })

  test('deduplicates repeated file paths', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: { file_path: 'x.ts' }, outputLength: 1 })
    acc.record({ toolName: 'Edit', input: { file_path: 'x.ts' }, outputLength: 1 })
    assert.deepEqual(acc.getExploredFiles(), ['x.ts'])
  })
})

describe('ToolActivityAccumulator — discovery summary', () => {
  test('empty accumulator returns empty string', () => {
    assert.equal(new ToolActivityAccumulator().buildDiscoverySummary(1000), '')
  })

  test('summary includes counts, files, and top tools', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: { file_path: 'a.ts' }, outputLength: 10 })
    acc.record({ toolName: 'Read', input: { file_path: 'b.ts' }, outputLength: 10 })
    acc.record({ toolName: 'Bash', input: { command: 'ls' }, outputLength: 10 })
    const summary = acc.buildDiscoverySummary(1000)
    assert.ok(summary.includes('Tool calls: 3'))
    assert.ok(summary.includes('Files explored: a.ts, b.ts'))
    assert.ok(summary.includes('Read(2)'))
  })

  test('truncates the file list when over the char budget', () => {
    const acc = new ToolActivityAccumulator()
    for (let i = 0; i < 10; i++) {
      acc.record({ toolName: 'Read', input: { file_path: `file-${i}.ts` }, outputLength: 1 })
    }
    // Tiny budget forces the truncated "(+N more)" branch.
    const summary = acc.buildDiscoverySummary(60)
    assert.ok(summary.includes('more)'))
  })
})

describe('ToolActivityAccumulator — tokens, count, reset', () => {
  test('estimates tokens as ceil(totalChars / 3.5)', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: {}, outputLength: 7 })
    acc.record({ toolName: 'Read', input: {}, outputLength: 7 })
    // 14 / 3.5 = 4
    assert.equal(acc.getEstimatedTokensConsumed(), 4)
  })

  test('count and getEntries reflect recorded entries', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Bash', input: {}, outputLength: 1 })
    assert.equal(acc.count, 1)
    assert.equal(acc.getEntries().length, 1)
    assert.equal(acc.getEntries()[0].toolName, 'Bash')
  })

  test('reset clears all state', () => {
    const acc = new ToolActivityAccumulator()
    acc.record({ toolName: 'Read', input: { file_path: 'a.ts' }, outputLength: 100 })
    acc.reset()
    assert.equal(acc.count, 0)
    assert.deepEqual(acc.getExploredFiles(), [])
    assert.equal(acc.getEstimatedTokensConsumed(), 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
