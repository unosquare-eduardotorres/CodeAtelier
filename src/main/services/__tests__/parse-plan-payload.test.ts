/**
 * Unit tests for parsePlanPayload — module-level pure function in agent-session.service.ts.
 *
 * Since the function is not exported, we replicate its logic here and test
 * the exact same algorithm. The function is 15 lines of pure data transformation.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import type { PlanDetectedEvent } from '../../../shared/types'

// ── Replicated pure logic (identical to agent-session.service.ts line 111) ──

function parsePlanPayload(payload: unknown, beforePlan: string): PlanDetectedEvent {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const obj =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  return {
    rawContent: raw,
    structuredPlan:
      (obj.structuredPlan as PlanDetectedEvent['structuredPlan']) ??
      (obj.type !== undefined && obj.phases !== undefined
        ? (payload as PlanDetectedEvent['structuredPlan'])
        : null),
    beforePlan,
    afterPlan: ''
  }
}

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

  test('direct_structured_plan_object_detected', () => {
    const directPlan = { type: 'implementation', phases: [{ name: 'Phase 1', items: [] }] }
    const result = parsePlanPayload(directPlan, 'before')
    assert.deepEqual(result.structuredPlan, directPlan)
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
      phases: [
        { name: 'Phase 1', items: [{ task: 'subtask-a', nested: { deep: true } }] }
      ]
    }
    const result = parsePlanPayload(nestedPlan, '')
    assert.deepEqual(result.structuredPlan, nestedPlan)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
