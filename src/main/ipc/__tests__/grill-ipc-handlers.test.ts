/**
 * Tests for pure-logic functions extracted from grill.ipc.ts.
 *
 * Run: tsx src/main/ipc/__tests__/grill-ipc-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  resolveLlmProvider,
  shouldCondenseRequirement,
  formatPlanAsCardMessage
} from '../grill-ipc-handlers'

// ── resolveLlmProvider ───────────────────────────────────────────────────────

describe('resolveLlmProvider', () => {
  test('explicit provider wins', () => {
    assert.equal(resolveLlmProvider('openai-compatible' as any, 'claude'), 'openai-compatible')
  })

  test('workspace setting used when no explicit', () => {
    assert.equal(resolveLlmProvider(undefined, 'openai-compatible'), 'openai-compatible')
  })

  test('defaults to claude when both undefined', () => {
    assert.equal(resolveLlmProvider(undefined, undefined), 'claude')
  })

  test('explicit overrides even when workspace is set', () => {
    assert.equal(resolveLlmProvider('claude', 'openai-compatible'), 'claude')
  })
})

// ── shouldCondenseRequirement ────────────────────────────────────────────────

describe('shouldCondenseRequirement', () => {
  test('returns false for null', () => {
    assert.equal(shouldCondenseRequirement(null), false)
  })

  test('returns false for undefined', () => {
    assert.equal(shouldCondenseRequirement(undefined), false)
  })

  test('returns false for empty string', () => {
    assert.equal(shouldCondenseRequirement(''), false)
  })

  test('returns false for short text (under 1000 chars)', () => {
    assert.equal(shouldCondenseRequirement('a'.repeat(999)), false)
  })

  test('returns true for text at exactly 1000 chars', () => {
    assert.equal(shouldCondenseRequirement('a'.repeat(1000)), true)
  })

  test('returns true for long text', () => {
    assert.equal(shouldCondenseRequirement('a'.repeat(5000)), true)
  })
})

// ── formatPlanAsCardMessage ──────────────────────────────────────────────────

describe('formatPlanAsCardMessage', () => {
  test('wraps plan in code fence with lead-in', () => {
    const plan = { title: 'Test', phases: [] } as any
    const msg = formatPlanAsCardMessage(plan, 'Here is the plan.')
    assert.ok(msg.startsWith('Here is the plan.'))
    assert.ok(msg.includes('```plan'))
    assert.ok(msg.includes('```'))
    assert.ok(msg.includes(JSON.stringify(plan)))
  })

  test('handles empty lead-in', () => {
    const plan = { title: 'X' } as any
    const msg = formatPlanAsCardMessage(plan, '')
    assert.ok(msg.startsWith('\n\n'))
    assert.ok(msg.includes('```plan'))
  })

  test('JSON-serializes plan content', () => {
    const plan = { title: 'A', summary: 'B', phases: [{ id: 1 }] } as any
    const msg = formatPlanAsCardMessage(plan, 'intro')
    assert.ok(msg.includes('"phases"'))
    assert.ok(msg.includes('"id":1'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
