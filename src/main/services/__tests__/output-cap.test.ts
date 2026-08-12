/**
 * Unit tests for output-cap — MCP server output truncation.
 *
 * Tests all 3 truncation strategies:
 *   1. JSON array trimming (binary search)
 *   2. Markdown table row trimming
 *   3. Fallback head/tail
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { truncateToolOutput } from '../../mcp-servers/output-cap'

describe('truncateToolOutput', () => {
  // ── Passthrough (no truncation needed) ──

  test('returns original string when under budget', () => {
    const input = 'short output'
    assert.equal(truncateToolOutput(input), input)
  })

  test('returns original string when exactly at budget', () => {
    const input = 'x'.repeat(30_000)
    assert.equal(truncateToolOutput(input), input)
  })

  // ── Strategy 1: JSON array trimming ──

  test('JSON object with array — trims items to fit budget', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      name: `symbol_${i}_with_extra_padding`,
      file: `src/services/deeply/nested/path/to/long-filename-for-testing-${i}.ts`,
      line: i + 1,
      kind: 'function',
      description: `A function that does something important number ${i}`
    }))
    const input = JSON.stringify({ results: items, count: items.length })
    // Should exceed default budget
    assert.ok(input.length > 30_000, 'input must exceed budget for this test')

    const result = truncateToolOutput(input)
    assert.ok(result.length <= 30_100, 'result should be within budget + notice')

    // Should still be valid JSON (before the notice)
    const jsonPart = result.split('\n[...')[0]
    const parsed = JSON.parse(jsonPart)
    assert.ok(Array.isArray(parsed.results), 'results should be an array')
    assert.ok(parsed.results.length < items.length, 'array should be trimmed')
    assert.ok(parsed.results.length > 0, 'should keep at least 1 item')

    // Should contain omission notice
    assert.ok(result.includes('more items omitted'), 'should include omission notice')
  })

  test('JSON top-level array — trims items to fit budget', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }))
    const input = JSON.stringify(items)
    assert.ok(input.length > 30_000, 'input must exceed budget')

    const result = truncateToolOutput(input)
    assert.ok(result.length <= 30_100, 'result should fit budget')

    const jsonPart = result.split('\n[...')[0]
    const parsed = JSON.parse(jsonPart)
    assert.ok(Array.isArray(parsed), 'should be an array')
    assert.ok(parsed.length < items.length, 'should be trimmed')
  })

  test('JSON with custom maxChars — trims at given limit', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ name: `item_${i}` }))
    const input = JSON.stringify({ results: items })
    const result = truncateToolOutput(input, 500)
    assert.ok(result.length <= 600, 'should fit within custom budget + notice')

    const jsonPart = result.split('\n[...')[0]
    const parsed = JSON.parse(jsonPart)
    assert.ok(parsed.results.length < 100, 'should be trimmed')
  })

  test('JSON without arrays — falls through to fallback', () => {
    const obj = { key: 'x'.repeat(40_000) }
    const input = JSON.stringify(obj)
    const result = truncateToolOutput(input)
    // Should use fallback (head/tail) since there's no array to trim
    assert.ok(result.includes('chars truncated'), 'should use fallback strategy')
  })

  test('JSON with empty array — falls through to fallback', () => {
    const input = JSON.stringify({ results: [], padding: 'x'.repeat(40_000) })
    const result = truncateToolOutput(input)
    assert.ok(result.includes('chars truncated'), 'should fall through to fallback')
  })

  // ── Strategy 2: Markdown table trimming ──

  test('markdown table — trims rows, preserves header', () => {
    const rows = Array.from(
      { length: 500 },
      (_, i) => `| symbol_${i} | src/services/very-long-filename-${i}.ts | ${i + 1} |`
    )
    const input = [
      '### Dead Code (500 unreferenced symbols)',
      '',
      '| Symbol | File | Line |',
      '|--------|------|------|',
      ...rows
    ].join('\n')
    assert.ok(input.length > 30_000, 'input must exceed budget')

    const result = truncateToolOutput(input)
    assert.ok(result.length <= 30_100, 'result should fit budget')

    // Header and separator should be preserved
    assert.ok(result.includes('| Symbol | File | Line |'), 'header should be preserved')
    assert.ok(result.includes('|--------|------|------|'), 'separator should be preserved')

    // Should contain omission notice
    assert.ok(result.includes('more rows'), 'should include row omission notice')

    // First data row should be preserved
    assert.ok(result.includes('symbol_0'), 'first row should be preserved')
  })

  test('markdown table with text after table — preserves post-table content', () => {
    const rows = Array.from({ length: 500 }, (_, i) => `| func_${i} | ${i + 10} |`)
    const input = [
      '## Complexity',
      '',
      '| Function | Complexity |',
      '|----------|-----------|',
      ...rows,
      '',
      '**Summary:** avg=15.2, max=42'
    ].join('\n')

    const result = truncateToolOutput(input, 5_000)

    // Header should be preserved
    assert.ok(result.includes('| Function | Complexity |'))
    // Post-table summary should be preserved
    assert.ok(result.includes('**Summary:**'), 'post-table content should be preserved')
  })

  // ── Strategy 3: Fallback (head/tail) ──

  test('plain text — uses head/tail fallback', () => {
    const input = 'A'.repeat(50_000)
    const result = truncateToolOutput(input)
    assert.ok(result.length < input.length, 'result should be shorter')
    assert.ok(result.startsWith('A'.repeat(5000)), 'head should be preserved')
    assert.ok(result.includes('chars truncated'), 'should contain truncation notice')
    assert.ok(result.endsWith('A'), 'tail should end with original content')
  })

  test('truncation notice includes removed char count', () => {
    const input = 'B'.repeat(40_000)
    const result = truncateToolOutput(input)
    // Removed = 40000 - 30000 = 10000
    assert.ok(result.includes('10,000'), 'should mention 10,000 removed chars')
  })

  test('custom maxChars truncates at the given limit', () => {
    const input = 'C'.repeat(20_000)
    const result = truncateToolOutput(input, 10_000)
    assert.ok(result.length < input.length, 'result should be shorter')
    assert.ok(result.includes('truncated'), 'should contain truncation notice')
  })

  test('head portion is preserved (first 5000 chars)', () => {
    const head = 'H'.repeat(5000)
    const middle = 'M'.repeat(30_000)
    const tail = 'T'.repeat(5000)
    const input = head + middle + tail
    const result = truncateToolOutput(input)
    assert.equal(result.slice(0, 5000), head, 'first 5000 chars should be the head')
  })

  test('tail portion is preserved at end', () => {
    const input = 'X'.repeat(5000) + 'Y'.repeat(30_000) + 'Z'.repeat(5000)
    const result = truncateToolOutput(input)
    assert.ok(result.endsWith('Z'), 'should end with tail chars')
  })

  // ── Edge cases ──

  test('invalid JSON starting with { — falls through to fallback', () => {
    const input = '{ not valid json ' + 'x'.repeat(40_000)
    const result = truncateToolOutput(input)
    assert.ok(result.includes('chars truncated'), 'should use fallback')
  })

  test('markdown without table separator — falls through to fallback', () => {
    const input = '# Heading\n' + 'line\n'.repeat(10_000)
    const result = truncateToolOutput(input)
    assert.ok(result.includes('chars truncated'), 'should use fallback')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
