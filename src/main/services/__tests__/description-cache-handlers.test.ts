/**
 * Unit tests for description-cache-handlers.ts — pure-logic helpers
 * extracted from DescriptionCacheService.
 *
 * Covers:
 * - makeDescriptionKey: determinism, input sensitivity, empty values
 * - parseBatchDescriptionOutput: valid format, malformed lines, out-of-range, empty
 * - aggregateSourceCounts: empty rows, AI-only, mixed, unknown sources
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  makeDescriptionKey,
  parseBatchDescriptionOutput,
  aggregateSourceCounts
} from '../description-cache-handlers'

// ── makeDescriptionKey ──

describe('makeDescriptionKey', () => {
  test('produces deterministic output', () => {
    const key1 = makeDescriptionKey('src/app.ts', 'App', 'class App {}')
    const key2 = makeDescriptionKey('src/app.ts', 'App', 'class App {}')
    assert.equal(key1, key2)
  })

  test('different file path produces different key', () => {
    const key1 = makeDescriptionKey('src/a.ts', 'Fn', 'body')
    const key2 = makeDescriptionKey('src/b.ts', 'Fn', 'body')
    assert.notEqual(key1, key2)
  })

  test('different symbol name produces different key', () => {
    const key1 = makeDescriptionKey('src/a.ts', 'Alpha', 'body')
    const key2 = makeDescriptionKey('src/a.ts', 'Beta', 'body')
    assert.notEqual(key1, key2)
  })

  test('different body produces different key', () => {
    const key1 = makeDescriptionKey('src/a.ts', 'Fn', 'function a() {}')
    const key2 = makeDescriptionKey('src/a.ts', 'Fn', 'function b() {}')
    assert.notEqual(key1, key2)
  })

  test('returns 64-char hex string (SHA-256)', () => {
    const key = makeDescriptionKey('path', 'name', 'body')
    assert.equal(key.length, 64)
    assert.match(key, /^[a-f0-9]{64}$/)
  })

  test('handles empty values', () => {
    const key = makeDescriptionKey('', '', '')
    assert.equal(key.length, 64)
    assert.match(key, /^[a-f0-9]{64}$/)
  })
})

// ── parseBatchDescriptionOutput ──

describe('parseBatchDescriptionOutput', () => {
  test('parses valid numbered output', () => {
    const output = '1: Does authentication\n2: Handles routing\n3: Manages state'
    const result = parseBatchDescriptionOutput(output, 3)
    assert.equal(result.size, 3)
    assert.equal(result.get(0), 'Does authentication')
    assert.equal(result.get(1), 'Handles routing')
    assert.equal(result.get(2), 'Manages state')
  })

  test('trims description text', () => {
    const output = '1:   Has extra spaces   '
    const result = parseBatchDescriptionOutput(output, 1)
    assert.equal(result.get(0), 'Has extra spaces')
  })

  test('skips malformed lines', () => {
    const output = '1: Valid line\nNot a numbered line\n: Missing number\n2: Also valid'
    const result = parseBatchDescriptionOutput(output, 3)
    assert.equal(result.size, 2)
    assert.equal(result.get(0), 'Valid line')
    assert.equal(result.get(1), 'Also valid')
  })

  test('skips out-of-range indices', () => {
    const output = '1: Valid\n5: Out of range\n0: Zero is invalid (1-based)'
    const result = parseBatchDescriptionOutput(output, 2)
    assert.equal(result.size, 1)
    assert.equal(result.get(0), 'Valid')
    // Index 4 (5-1) >= maxIndex 2, so skipped
    assert.ok(!result.has(4))
  })

  test('handles empty output', () => {
    const result = parseBatchDescriptionOutput('', 5)
    assert.equal(result.size, 0)
  })

  test('handles output with only blank lines', () => {
    const result = parseBatchDescriptionOutput('\n\n\n', 5)
    assert.equal(result.size, 0)
  })

  test('skips negative indices (0 in 1-based = -1 in 0-based)', () => {
    const output = '0: Zero-based attempt'
    const result = parseBatchDescriptionOutput(output, 5)
    // 0-1 = -1, which is < 0, so skipped
    assert.equal(result.size, 0)
  })
})

// ── aggregateSourceCounts ──

describe('aggregateSourceCounts', () => {
  test('returns zeros for empty rows', () => {
    const result = aggregateSourceCounts([])
    assert.deepEqual(result, { ai: 0, heuristic: 0, total: 0 })
  })

  test('aggregates AI-only counts', () => {
    const result = aggregateSourceCounts([{ source: 'ai', count: 42 }])
    assert.deepEqual(result, { ai: 42, heuristic: 0, total: 42 })
  })

  test('aggregates heuristic-only counts', () => {
    const result = aggregateSourceCounts([{ source: 'heuristic', count: 10 }])
    assert.deepEqual(result, { ai: 0, heuristic: 10, total: 10 })
  })

  test('aggregates mixed sources correctly', () => {
    const result = aggregateSourceCounts([
      { source: 'ai', count: 30 },
      { source: 'heuristic', count: 15 }
    ])
    assert.deepEqual(result, { ai: 30, heuristic: 15, total: 45 })
  })

  test('ignores unknown source types', () => {
    const result = aggregateSourceCounts([
      { source: 'ai', count: 10 },
      { source: 'manual', count: 5 },
      { source: 'heuristic', count: 3 }
    ])
    // 'manual' is ignored; total = ai + heuristic only
    assert.deepEqual(result, { ai: 10, heuristic: 3, total: 13 })
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
