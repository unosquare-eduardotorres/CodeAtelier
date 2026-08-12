/**
 * Phase 27 — structured-output-repair.ts deep branch coverage.
 *
 * Tests extractJson and validateAgainstSchema — both are pure functions.
 * Focuses on uncovered branches: code fence extraction, brace matching,
 * JSON cleanup (trailing commas, comments, single quotes), and schema validation.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { extractJson, validateAgainstSchema, type JsonSchema } from '../structured-output-repair'

// ── extractJson — Strategy 1: Direct parse ──

describe('extractJson — direct JSON parse', () => {
  test('parses valid JSON object directly', () => {
    const result = extractJson('{"name": "test", "value": 42}')
    assert.deepEqual(result.json, { name: 'test', value: 42 })
    assert.equal(result.error, undefined)
  })

  test('parses valid JSON array directly', () => {
    const result = extractJson('[1, 2, 3]')
    assert.deepEqual(result.json, [1, 2, 3])
  })

  test('parses valid JSON string directly', () => {
    const result = extractJson('"hello"')
    assert.equal(result.json, 'hello')
  })

  test('handles whitespace around JSON', () => {
    const result = extractJson('  {"a": 1}  ')
    assert.deepEqual(result.json, { a: 1 })
  })
})

// ── extractJson — Strategy 2: Code fence extraction ──

describe('extractJson — code fence extraction', () => {
  test('extracts JSON from ```json code fence', () => {
    const text = 'Here is the output:\n```json\n{"status": "ok"}\n```\nDone.'
    const result = extractJson(text)
    assert.deepEqual(result.json, { status: 'ok' })
  })

  test('extracts JSON from generic ``` code fence', () => {
    const text = 'Result:\n```\n{"items": [1, 2, 3]}\n```'
    const result = extractJson(text)
    assert.deepEqual(result.json, { items: [1, 2, 3] })
  })

  test('handles trailing commas in fenced JSON', () => {
    const text = '```json\n{"a": 1, "b": 2,}\n```'
    const result = extractJson(text)
    assert.deepEqual(result.json, { a: 1, b: 2 })
  })
})

// ── extractJson — Strategy 3: Brace matching ──

describe('extractJson — brace matching extraction', () => {
  test('extracts object from text with preamble', () => {
    const text = 'The result is: {"name": "test", "score": 95}'
    const result = extractJson(text)
    assert.deepEqual(result.json, { name: 'test', score: 95 })
  })

  test('extracts array from text with preamble', () => {
    const text = 'Items found: [{"id": 1}, {"id": 2}]'
    const result = extractJson(text)
    const json = result.json as Array<{ id: number }>
    assert.equal(json.length, 2)
    assert.equal(json[0].id, 1)
  })

  test('handles nested braces correctly', () => {
    const text = 'Output: {"outer": {"inner": {"deep": true}}}'
    const result = extractJson(text)
    const json = result.json as Record<string, any>
    assert.equal(json.outer.inner.deep, true)
  })

  test('handles strings with escaped quotes', () => {
    const text = '{"msg": "He said \\"hello\\""}'
    const result = extractJson(text)
    const json = result.json as Record<string, string>
    assert.equal(json.msg, 'He said "hello"')
  })

  test('handles text after the JSON', () => {
    const text = '{"status": "done"} And then some extra text afterwards.'
    const result = extractJson(text)
    assert.deepEqual(result.json, { status: 'done' })
  })
})

// ── extractJson — Strategy 4: JSON cleanup ──

describe('extractJson — JSON cleanup strategies', () => {
  test('removes single-line comments', () => {
    const text = '{"a": 1 // comment\n}'
    const result = extractJson(text)
    assert.deepEqual(result.json, { a: 1 })
  })

  test('removes trailing commas before closing brace', () => {
    const text = '{"a": 1, "b": 2,}'
    const result = extractJson(text)
    assert.deepEqual(result.json, { a: 1, b: 2 })
  })

  test('removes trailing commas before closing bracket', () => {
    const text = '[1, 2, 3,]'
    const result = extractJson(text)
    assert.deepEqual(result.json, [1, 2, 3])
  })

  test('replaces single quotes when no double quotes present', () => {
    const text = "{'name': 'test', 'value': 42}"
    const result = extractJson(text)
    assert.deepEqual(result.json, { name: 'test', value: 42 })
  })

  test('returns error for completely invalid text', () => {
    const result = extractJson('This is not JSON at all')
    assert.equal(result.json, null)
    assert.ok(result.error !== undefined)
    assert.ok(result.error!.includes('Failed to extract JSON'))
  })

  test('returns error for empty string', () => {
    const result = extractJson('')
    assert.equal(result.json, null)
    assert.ok(result.error !== undefined)
  })
})

// ── validateAgainstSchema — object validation ──

describe('validateAgainstSchema — object validation', () => {
  const userSchema: JsonSchema = {
    type: 'object',
    required: ['name', 'age'],
    properties: {
      name: { type: 'string' },
      age: { type: 'number' },
      email: { type: 'string' }
    }
  }

  test('valid object returns no errors', () => {
    const errors = validateAgainstSchema({ name: 'John', age: 30 }, userSchema)
    assert.equal(errors.length, 0)
  })

  test('missing required field returns error', () => {
    const errors = validateAgainstSchema({ name: 'John' }, userSchema)
    assert.ok(errors.length > 0)
    assert.ok(errors.some((e) => e.includes('age')))
  })

  test('wrong type for field returns error', () => {
    const errors = validateAgainstSchema({ name: 123, age: 30 }, userSchema)
    assert.ok(errors.length > 0)
  })

  test('non-object returns error', () => {
    const errors = validateAgainstSchema('not an object', userSchema)
    assert.ok(errors.length > 0)
  })

  test('null returns error', () => {
    const errors = validateAgainstSchema(null, userSchema)
    assert.ok(errors.length > 0)
  })
})

describe('validateAgainstSchema — array validation', () => {
  const arraySchema: JsonSchema = {
    type: 'array',
    items: { type: 'string' }
  }

  test('valid array returns no errors', () => {
    const errors = validateAgainstSchema(['a', 'b', 'c'], arraySchema)
    assert.equal(errors.length, 0)
  })

  test('non-array returns error', () => {
    const errors = validateAgainstSchema('not an array', arraySchema)
    assert.ok(errors.length > 0)
  })

  test('array with wrong item types returns errors', () => {
    const errors = validateAgainstSchema([1, 2, 3], arraySchema)
    assert.ok(errors.length > 0)
  })
})

describe('validateAgainstSchema — primitive validation', () => {
  test('string type validates correctly', () => {
    const errors = validateAgainstSchema('hello', { type: 'string' })
    assert.equal(errors.length, 0)
  })

  test('number type validates correctly', () => {
    const errors = validateAgainstSchema(42, { type: 'number' })
    assert.equal(errors.length, 0)
  })

  test('boolean type validates correctly', () => {
    const errors = validateAgainstSchema(true, { type: 'boolean' })
    assert.equal(errors.length, 0)
  })

  test('wrong primitive type returns error', () => {
    const errors = validateAgainstSchema(42, { type: 'string' })
    assert.ok(errors.length > 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
