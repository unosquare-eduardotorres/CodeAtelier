/**
 * Unit tests for db/json-utils.ts — safeParseJSON defensive JSON parser.
 *
 * Phase 6A Coverage Improvement — lines 19-26 (currently 65% → 80%+).
 * All three branches: falsy input, valid JSON, malformed JSON.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { safeParseJSON } from '../../db/json-utils'

describe('safeParseJSON', () => {
  // ── Falsy input → fallback ──

  test('null → returns fallback', () => {
    const fallback = { default: true }
    assert.deepEqual(safeParseJSON(null, fallback), fallback)
  })

  test('undefined → returns fallback', () => {
    assert.deepEqual(safeParseJSON(undefined, []), [])
  })

  test('empty string → returns fallback', () => {
    const fallback = { safe: 'value' }
    assert.equal(safeParseJSON('', fallback), fallback)
  })

  // ── Valid JSON → parsed result ──

  test('valid object JSON → parses correctly', () => {
    const result = safeParseJSON<{ a: number; b: number }>('{"a":1,"b":2}', {})
    assert.deepEqual(result, { a: 1, b: 2 })
  })

  test('valid array JSON → parses correctly', () => {
    const result = safeParseJSON<number[]>('[1,2,3]', [])
    assert.deepEqual(result, [1, 2, 3])
  })

  test('valid primitive JSON (number) → parses correctly', () => {
    assert.equal(safeParseJSON('42', 0), 42)
  })

  test('valid string JSON → parses correctly', () => {
    assert.equal(safeParseJSON('"hello"', ''), 'hello')
  })

  test('valid boolean JSON → parses correctly', () => {
    assert.equal(safeParseJSON('true', false), true)
  })

  test('valid null JSON → returns null (not fallback)', () => {
    assert.equal(safeParseJSON('null', 'fallback'), null)
  })

  // ── Malformed JSON → logs warning + returns fallback ──

  test('malformed JSON {unclosed → returns fallback', () => {
    const fallback = { safe: 'default' }
    const result = safeParseJSON('{unclosed', fallback)
    assert.equal(result, fallback)
  })

  test('malformed JSON trailing comma → returns fallback', () => {
    const fallback: string[] = []
    const result = safeParseJSON('[1,2,]', fallback)
    assert.equal(result, fallback)
  })

  test('non-JSON text → returns fallback', () => {
    const fallback = { empty: true }
    const result = safeParseJSON('not json at all', fallback)
    assert.equal(result, fallback)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
