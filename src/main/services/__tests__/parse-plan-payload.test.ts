/**
 * Unit tests for parsePlanPayload — canonical implementation in agent-session-handlers.ts.
 *
 * These tests import the shared implementation directly, ensuring any logic
 * changes propagate to all consumers. Covers: string payloads, object payloads,
 * direct StructuredPlan shapes (type+phases and title+phases), JSON string
 * fallback, null/undefined, and edge cases.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parsePlanPayload } from '../agent-session-handlers'

describe('parsePlanPayload', () => {
  // ── String payload ──

  test('string_payload_wraps_in_rawContent', () => {
    const result = parsePlanPayload('my plan text', 'before')
    assert.equal(result.rawContent, 'my plan text')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.beforePlan, 'before')
    assert.equal(result.afterPlan, '')
  })

  test('empty_string_payload', () => {
    const result = parsePlanPayload('', 'pre')
    assert.equal(result.rawContent, '')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.beforePlan, 'pre')
  })

  // ── Object with structuredPlan ──

  test('object_with_structuredPlan_passes_through', () => {
    const plan = { type: 'implementation', phases: [{ name: 'Phase 1', items: [] }] }
    const result = parsePlanPayload({ structuredPlan: plan }, 'before')
    assert.deepEqual(result.structuredPlan, plan)
    assert.equal(result.beforePlan, 'before')
  })

  // ── Direct StructuredPlan shape (has type + phases) ──

  test('direct_structured_plan_object_with_type_and_phases_detected', () => {
    const directPlan = { type: 'implementation', phases: [{ name: 'Phase 1', items: [] }] }
    const result = parsePlanPayload(directPlan, 'before')
    assert.deepEqual(result.structuredPlan, directPlan)
  })

  // ── Direct StructuredPlan shape (has title + phases, no type — MCP emit_plan path) ──

  test('direct_structured_plan_object_with_title_and_phases_detected', () => {
    const mcpPlan = { title: 'Fix auth', summary: 'Fix the auth bug', phases: [{ id: 1, title: 'Audit' }] }
    const result = parsePlanPayload(mcpPlan, 'before')
    assert.ok(result.structuredPlan !== null, 'title+phases should be detected as structuredPlan')
    assert.equal((result.structuredPlan as unknown as Record<string, unknown>).title, 'Fix auth')
  })

  // ── JSON string fallback ──

  test('json_string_containing_plan_parsed_via_fallback', () => {
    const plan = { title: 'Deploy', phases: [{ id: 1, title: 'Build' }] }
    const result = parsePlanPayload(JSON.stringify(plan), 'ctx')
    assert.ok(result.structuredPlan !== null, 'JSON string with title+phases should be parsed')
    assert.equal((result.structuredPlan as unknown as Record<string, unknown>).title, 'Deploy')
  })

  test('json_string_without_plan_fields_stays_null', () => {
    const result = parsePlanPayload(JSON.stringify({ foo: 'bar' }), '')
    assert.equal(result.structuredPlan, null)
  })

  test('non_json_string_stays_null', () => {
    const result = parsePlanPayload('just plain text, not JSON', '')
    assert.equal(result.structuredPlan, null)
  })

  // ── Object without plan fields ──

  test('object_without_plan_fields_returns_null_structuredPlan', () => {
    const result = parsePlanPayload({ foo: 'bar' }, 'before')
    assert.equal(result.structuredPlan, null)
  })

  // ── null/undefined ──

  test('null_payload_returns_fallback', () => {
    const result = parsePlanPayload(null, 'before-text')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.beforePlan, 'before-text')
    assert.equal(result.rawContent, 'null')
  })

  test('undefined_payload_returns_fallback', () => {
    const result = parsePlanPayload(undefined, 'pre')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.beforePlan, 'pre')
  })

  // ── beforePlan preservation ──

  test('beforePlan_text_is_preserved', () => {
    const result = parsePlanPayload('plan', 'I will implement this by...')
    assert.equal(result.beforePlan, 'I will implement this by...')
  })

  // ── afterPlan always empty ──

  test('afterPlan_is_always_empty_string', () => {
    const result = parsePlanPayload({ type: 'x', phases: [] }, 'before')
    assert.equal(result.afterPlan, '')
  })

  // ── rawContent for objects ──

  test('object_rawContent_is_JSON_stringified', () => {
    const result = parsePlanPayload({ a: 1 }, '')
    assert.equal(result.rawContent, JSON.stringify({ a: 1 }))
  })

  // ── Nested plan ──

  test('deeply_nested_plan_preserves_structure', () => {
    const nestedPlan = {
      type: 'complex',
      phases: [{ name: 'Phase 1', items: [{ task: 'subtask-a', nested: { deep: true } }] }]
    }
    const result = parsePlanPayload(nestedPlan, '')
    assert.deepEqual(result.structuredPlan, nestedPlan)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
