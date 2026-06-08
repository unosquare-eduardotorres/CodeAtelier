/**
 * Unit tests for structured-output-repair.ts — JSON extraction, schema
 * validation, and the retry-with-repair loop for local LLM structured output.
 *
 * The repair callback is injected, so the loop is tested with createSpy
 * (no real LLM). Logger import is safe under tsx.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './test-harness'
import {
  extractJson,
  validateAgainstSchema,
  retryWithRepair,
  type JsonSchema
} from '../structured-output-repair'

describe('extractJson', () => {
  test('strategy 1 — direct parse', () => {
    assert.deepEqual(extractJson('{"a":1}').json, { a: 1 })
  })

  test('strategy 2 — json code fence', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```').json, { a: 1 })
  })

  test('strategy 2 — generic code fence', () => {
    assert.deepEqual(extractJson('```\n{"b":2}\n```').json, { b: 2 })
  })

  test('strategy 3 — find first brace amid surrounding text', () => {
    assert.deepEqual(extractJson('Here you go: {"c":3} done').json, { c: 3 })
  })

  test('strategy 3 — find first bracket (array)', () => {
    assert.deepEqual(extractJson('result = [1,2,3]').json, [1, 2, 3])
  })

  test('strategy 4 — clean trailing commas', () => {
    assert.deepEqual(extractJson('{"a":1,}').json, { a: 1 })
  })

  test('clean single quotes when no double quotes present', () => {
    assert.deepEqual(extractJson("{'a': 1}").json, { a: 1 })
  })

  test('returns null + error for unparseable text', () => {
    const r = extractJson('this is not json at all !!!')
    assert.equal(r.json, null)
    assert.ok(r.error)
  })

  test('handles nested braces and strings with braces inside', () => {
    const r = extractJson('prefix {"a":{"b":"}{"},"c":1} suffix')
    assert.deepEqual(r.json, { a: { b: '}{' }, c: 1 })
  })
})

describe('validateAgainstSchema', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['name', 'score'],
    properties: { name: { type: 'string' }, score: { type: 'number' } }
  }

  test('valid object yields no errors', () => {
    assert.deepEqual(validateAgainstSchema({ name: 'x', score: 5 }, schema), [])
  })

  test('missing required fields are reported', () => {
    const errs = validateAgainstSchema({ name: 'x' }, schema)
    assert.ok(errs.some((e) => e.includes('score')))
  })

  test('wrong property type is reported with key prefix', () => {
    const errs = validateAgainstSchema({ name: 1, score: 5 }, schema)
    assert.ok(errs.some((e) => e.startsWith('name:')))
  })

  test('non-object where object expected', () => {
    assert.deepEqual(validateAgainstSchema([], schema), ['Expected an object'])
  })

  test('array item validation with index prefix', () => {
    const arrSchema: JsonSchema = { type: 'array', items: { type: 'number' } }
    const errs = validateAgainstSchema([1, 'two', 3], arrSchema)
    assert.ok(errs.some((e) => e.startsWith('[1]:')))
  })

  test('non-array where array expected', () => {
    assert.deepEqual(validateAgainstSchema({}, { type: 'array' }), ['Expected an array'])
  })

  test('primitive type mismatches', () => {
    assert.ok(validateAgainstSchema(1, { type: 'string' }).length > 0)
    assert.ok(validateAgainstSchema('x', { type: 'number' }).length > 0)
    assert.ok(validateAgainstSchema('x', { type: 'boolean' }).length > 0)
  })
})

describe('retryWithRepair', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean' } }
  }

  test('valid on first attempt — no repair calls', async () => {
    const repair = createSpy<[string], Promise<string>>(async () => '{}')
    const result = await retryWithRepair('{"ok":true}', schema, repair)
    assert.equal(result.validOnFirstAttempt, true)
    assert.equal(result.repairAttempts, 0)
    assert.equal(repair.callCount, 0)
    assert.deepEqual(result.data, { ok: true })
  })

  test('repairs on second attempt', async () => {
    const repair = createSpy<[string], Promise<string>>(async () => '{"ok":true}')
    const result = await retryWithRepair('not json', schema, repair)
    assert.equal(result.validOnFirstAttempt, false)
    assert.equal(result.repairAttempts, 1)
    assert.deepEqual(result.data, { ok: true })
  })

  test('exhausts retries when repair never produces valid JSON', async () => {
    const repair = createSpy<[string], Promise<string>>(async () => 'still broken')
    const result = await retryWithRepair('broken', schema, repair, 2)
    assert.equal(result.repairAttempts, 2)
    assert.equal(result.data, null)
    assert.ok(result.lastErrors.length > 0)
  })

  test('repair callback throwing is tolerated and counted', async () => {
    const repair = createSpy<[string], Promise<string>>(async () => {
      throw new Error('network')
    })
    const result = await retryWithRepair('broken', schema, repair, 2)
    assert.equal(result.repairAttempts, 2)
    assert.equal(result.data, null)
  })

  test('returns best-effort parse even if schema-invalid after exhaustion', async () => {
    // Parses fine but fails schema (missing required `ok`) — best-effort data returned.
    const repair = createSpy<[string], Promise<string>>(async () => '{"other":1}')
    const result = await retryWithRepair('{"other":1}', schema, repair, 1)
    assert.deepEqual(result.data, { other: 1 })
    assert.ok(result.lastErrors.some((e) => e.includes('ok')))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
