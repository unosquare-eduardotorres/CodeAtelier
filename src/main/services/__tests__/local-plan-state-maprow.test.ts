/**
 * Unit tests for local-plan-state.service.ts — mapRow function.
 *
 * Tests JSON parsing, error handling, and status mapping in the mapRow
 * function. Pure logic, no database.
 *
 * Phase 4F — ~8 tests.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { mapRow, type PlanStateRow } from '../local-plan-state.service'

function makeRow(overrides: Partial<PlanStateRow> = {}): PlanStateRow {
  return {
    id: 'plan-001',
    conversation_id: 'conv-001',
    workspace_id: 'ws-001',
    original_request: 'Build a login page',
    discovered_context: JSON.stringify({
      filesExplored: ['src/auth.ts'],
      keyFindings: ['Uses JWT'],
      planItems: ['Create component'],
      nextSteps: ['Add tests']
    }),
    plan_text: 'Step 1: scaffold\nStep 2: implement',
    status: 'in_progress',
    continuation_count: 2,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides
  }
}

describe('mapRow', () => {
  test('valid discovered_context JSON → parsed correctly', () => {
    const result = mapRow(makeRow())
    assert.deepEqual(result.discoveredContext.filesExplored, ['src/auth.ts'])
    assert.deepEqual(result.discoveredContext.keyFindings, ['Uses JWT'])
    assert.deepEqual(result.discoveredContext.planItems, ['Create component'])
    assert.deepEqual(result.discoveredContext.nextSteps, ['Add tests'])
  })

  test('invalid/corrupt discovered_context → graceful fallback', () => {
    const result = mapRow(makeRow({ discovered_context: 'not-valid-json' }))
    assert.deepEqual(result.discoveredContext, {
      filesExplored: [],
      keyFindings: [],
      planItems: [],
      nextSteps: []
    })
  })

  test('empty string discovered_context → graceful fallback', () => {
    const result = mapRow(makeRow({ discovered_context: '' }))
    assert.deepEqual(result.discoveredContext, {
      filesExplored: [],
      keyFindings: [],
      planItems: [],
      nextSteps: []
    })
  })

  test('null plan_text → empty string', () => {
    const result = mapRow(makeRow({ plan_text: null }))
    assert.equal(result.planText, '')
  })

  test('non-null plan_text → preserved', () => {
    const result = mapRow(makeRow({ plan_text: 'My plan' }))
    assert.equal(result.planText, 'My plan')
  })

  test('status "in_progress" → correctly mapped', () => {
    const result = mapRow(makeRow({ status: 'in_progress' }))
    assert.equal(result.status, 'in_progress')
  })

  test('status "completed" → correctly mapped', () => {
    const result = mapRow(makeRow({ status: 'completed' }))
    assert.equal(result.status, 'completed')
  })

  test('status "abandoned" → correctly mapped', () => {
    const result = mapRow(makeRow({ status: 'abandoned' }))
    assert.equal(result.status, 'abandoned')
  })

  test('all scalar fields mapped correctly', () => {
    const result = mapRow(makeRow())
    assert.equal(result.id, 'plan-001')
    assert.equal(result.conversationId, 'conv-001')
    assert.equal(result.workspaceId, 'ws-001')
    assert.equal(result.originalRequest, 'Build a login page')
    assert.equal(result.continuationCount, 2)
    assert.equal(result.createdAt, '2026-01-01T00:00:00Z')
    assert.equal(result.updatedAt, '2026-01-02T00:00:00Z')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
