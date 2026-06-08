/**
 * Unit tests for output-cap — MCP server output truncation.
 *
 * Pure function, zero dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { truncateToolOutput } from '../../mcp-servers/output-cap'

describe('truncateToolOutput', () => {
  test('returns original string when under budget', () => {
    const input = 'short output'
    assert.equal(truncateToolOutput(input), input)
  })

  test('returns original string when exactly at budget', () => {
    const input = 'x'.repeat(30_000)
    assert.equal(truncateToolOutput(input), input)
  })

  test('truncates when over default budget — head preserved', () => {
    const input = 'A'.repeat(50_000)
    const result = truncateToolOutput(input)
    // The result should be meaningfully shorter than the input
    assert.ok(result.length < input.length, 'result should be shorter than input')
    // Should start with the head (first 5000 chars of 'A')
    assert.ok(result.startsWith('A'.repeat(5000)))
    // Should contain the truncation notice with char count
    assert.ok(result.includes('chars truncated'))
    // Should end with 'A's from the tail
    assert.ok(result.endsWith('A'))
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
    // maxChars > HEAD_SIZE so truncation should produce something shorter
    assert.ok(result.length < input.length, 'result should be shorter than input')
    assert.ok(result.includes('truncated'), 'should contain truncation notice')
  })

  test('head portion is preserved (first 5000 chars)', () => {
    // Create distinct head and tail
    const head = 'H'.repeat(5000)
    const middle = 'M'.repeat(30_000)
    const tail = 'T'.repeat(5000)
    const input = head + middle + tail
    const result = truncateToolOutput(input)
    // First 5000 chars should be the head
    assert.equal(result.slice(0, 5000), head)
  })

  test('tail portion is preserved at end', () => {
    const input = 'X'.repeat(5000) + 'Y'.repeat(30_000) + 'Z'.repeat(5000)
    const result = truncateToolOutput(input)
    // Should end with 'Z' characters (tail)
    assert.ok(result.endsWith('Z'))
  })

  test('result contains head + separator + tail structure', () => {
    const input = 'D'.repeat(50_000)
    const result = truncateToolOutput(input)
    // The result should contain the truncation message
    assert.ok(result.includes('truncated'))
    assert.ok(result.includes('more targeted queries'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
