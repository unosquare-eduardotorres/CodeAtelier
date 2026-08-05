/**
 * Unit tests for agent-session-handlers.ts — pure-logic helpers
 * extracted from AgentSessionService.
 *
 * Covers:
 * - parsePlanPayload: structured plan, raw string, direct object, null/undefined, missing fields
 * - formatContextEnrichment: S12 path, S6 fallback, raw fallback, empty values
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parsePlanPayload, formatContextEnrichment } from '../agent-session-handlers'

// ── parsePlanPayload ──

describe('parsePlanPayload', () => {
  test('detects well-formed structuredPlan object', () => {
    const payload = {
      structuredPlan: {
        type: 'feature',
        title: 'Add auth',
        summary: 'Implement authentication',
        phases: [{ id: 1, title: 'Setup', complexity: 3, risk: 'low', description: 'Setup phase' }]
      }
    }
    const result = parsePlanPayload(payload, 'Before plan text')
    assert.ok(result.structuredPlan !== null)
    assert.equal(result.structuredPlan!.title, 'Add auth')
    assert.equal(result.beforePlan, 'Before plan text')
    assert.equal(result.afterPlan, '')
  })

  test('parses raw JSON string to rawContent', () => {
    const result = parsePlanPayload('raw plan text content', 'before')
    assert.equal(result.rawContent, 'raw plan text content')
    assert.equal(result.structuredPlan, null)
  })

  test('detects direct StructuredPlan object with type + phases', () => {
    const payload = {
      type: 'bugfix',
      title: 'Fix crash',
      summary: 'Fix the crash bug',
      phases: [{ id: 1, title: 'Debug', complexity: 2, risk: 'low', description: 'Debug it' }]
    }
    const result = parsePlanPayload(payload, '')
    // Should detect as structuredPlan since type + phases are present
    assert.ok(result.structuredPlan !== null)
  })

  test('null payload → null structuredPlan', () => {
    const result = parsePlanPayload(null, 'before')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.rawContent, 'null')
  })

  test('undefined payload → null structuredPlan', () => {
    const result = parsePlanPayload(undefined, 'before')
    assert.equal(result.structuredPlan, null)
  })

  test('object missing structuredPlan and type/phases → null structuredPlan, rawContent preserved', () => {
    const payload = { someRandomField: 'value', anotherField: 42 }
    const result = parsePlanPayload(payload, 'context')
    assert.equal(result.structuredPlan, null)
    assert.ok(result.rawContent.includes('someRandomField'))
    assert.equal(result.beforePlan, 'context')
  })

  test('beforePlan is passed through, afterPlan is always empty', () => {
    const result = parsePlanPayload('plan', 'my-before-plan')
    assert.equal(result.beforePlan, 'my-before-plan')
    assert.equal(result.afterPlan, '')
  })

  test('empty object → null structuredPlan', () => {
    const result = parsePlanPayload({}, '')
    assert.equal(result.structuredPlan, null)
    assert.equal(result.rawContent, '{}')
  })

  test('object with type but no phases → null structuredPlan', () => {
    const result = parsePlanPayload({ type: 'feature', title: 'Test' }, '')
    assert.equal(result.structuredPlan, null)
  })

  test('object with phases and title but no type → detected via title+phases path', () => {
    const result = parsePlanPayload({ phases: [], title: 'Test' }, '')
    // MCP emit_plan sends { title, phases } without type — this should be detected
    assert.ok(result.structuredPlan !== null)
  })

  test('MCP-shaped payload with title + summary + phases → structuredPlan populated', () => {
    const payload = {
      title: 'Fix auth',
      summary: 'Implement auth fix across 3 files',
      phases: [{ id: 1, title: 'Audit', complexity: 2, risk: 'low', description: 'Audit current auth' }]
    }
    const result = parsePlanPayload(payload, 'before')
    assert.ok(result.structuredPlan !== null)
    assert.equal((result.structuredPlan as unknown as Record<string, unknown>).title, 'Fix auth')
  })

  test('JSON string payload containing valid plan → structuredPlan populated via fallback parse', () => {
    const plan = { title: 'Deploy fix', phases: [{ id: 1, title: 'Build', complexity: 1, risk: 'low', description: 'Build it' }] }
    const result = parsePlanPayload(JSON.stringify(plan), 'context')
    assert.ok(result.structuredPlan !== null)
    assert.equal((result.structuredPlan as unknown as Record<string, unknown>).title, 'Deploy fix')
  })

  test('JSON string payload without plan fields → structuredPlan stays null', () => {
    const result = parsePlanPayload(JSON.stringify({ foo: 'bar' }), '')
    assert.equal(result.structuredPlan, null)
  })
})

// ── formatContextEnrichment ──

describe('formatContextEnrichment', () => {
  test('S12 path — wraps reconstructed context', () => {
    const result = formatContextEnrichment({
      message: 'Fix the bug',
      reconstructedContext: 'Previous plan was to refactor auth module',
      summary: 'Also has a summary'
    })
    assert.equal(result.path, 'reconstructed')
    assert.ok(result.enrichedMessage.includes('## Previous Context'))
    assert.ok(result.enrichedMessage.includes('Previous plan was to refactor auth module'))
    assert.ok(result.enrichedMessage.includes('## Current Request'))
    assert.ok(result.enrichedMessage.includes('Fix the bug'))
  })

  test('S6 fallback — uses summary when no reconstruction', () => {
    const result = formatContextEnrichment({
      message: 'Continue the task',
      reconstructedContext: null,
      summary: 'User was working on API endpoints'
    })
    assert.equal(result.path, 'summary')
    assert.ok(result.enrichedMessage.includes('## Previous Context'))
    assert.ok(result.enrichedMessage.includes('User was working on API endpoints'))
    assert.ok(result.enrichedMessage.includes('## Current Request'))
    assert.ok(result.enrichedMessage.includes('Continue the task'))
  })

  test('raw fallback — returns message unchanged when no context', () => {
    const result = formatContextEnrichment({
      message: 'Hello world',
      reconstructedContext: null,
      summary: null
    })
    assert.equal(result.path, 'raw')
    assert.equal(result.enrichedMessage, 'Hello world')
  })

  test('empty reconstruction falls through to S6', () => {
    const result = formatContextEnrichment({
      message: 'Test',
      reconstructedContext: '',
      summary: 'Summary here'
    })
    // Empty string is falsy → falls through to summary
    assert.equal(result.path, 'summary')
    assert.ok(result.enrichedMessage.includes('Summary here'))
  })

  test('both empty → returns raw message', () => {
    const result = formatContextEnrichment({
      message: 'Just a message',
      reconstructedContext: '',
      summary: ''
    })
    assert.equal(result.path, 'raw')
    assert.equal(result.enrichedMessage, 'Just a message')
  })

  test('S12 is prioritized over S6 when both present', () => {
    const result = formatContextEnrichment({
      message: 'msg',
      reconstructedContext: 'full reconstruction',
      summary: 'brief summary'
    })
    assert.equal(result.path, 'reconstructed')
    assert.ok(result.enrichedMessage.includes('full reconstruction'))
    assert.ok(!result.enrichedMessage.includes('brief summary'))
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
