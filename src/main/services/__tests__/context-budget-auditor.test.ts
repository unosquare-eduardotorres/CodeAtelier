/**
 * Unit tests for context-budget-auditor.ts — pre-flight context budget math
 * for local LLM requests.
 *
 * Pure logic (logger import is safe under tsx).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { auditContextBudget, estimateToolCount } from '../context-budget-auditor'

describe('auditContextBudget', () => {
  test('computes token math (system chars/3.5, tools×450, output reserve)', () => {
    const sys = 'x'.repeat(3500) // 3500 / 3.5 = 1000 tokens
    const b = auditContextBudget({
      systemPrompt: sys,
      toolCount: 10,
      contextWindow: 128_000,
      tier: 'medium'
    })
    assert.equal(b.estimatedSystemPromptTokens, 1000)
    assert.equal(b.estimatedToolSchemaTokens, 4500) // 10 × 450
    assert.equal(b.reservedForOutput, 8000) // medium tier
    // consumed = 1000 + 4500 + 8000 = 13500; available = 128000 - 13500
    assert.equal(b.availableForConversation, 114_500)
    assert.ok(Math.abs(b.warningRatio - 114_500 / 128_000) < 1e-9)
  })

  test('output reserve varies by tier', () => {
    const base = { systemPrompt: '', toolCount: 0, contextWindow: 100_000 }
    assert.equal(auditContextBudget({ ...base, tier: 'small' }).reservedForOutput, 4000)
    assert.equal(auditContextBudget({ ...base, tier: 'medium' }).reservedForOutput, 8000)
    assert.equal(auditContextBudget({ ...base, tier: 'large' }).reservedForOutput, 16000)
  })

  test('available clamps at 0 when consumption exceeds the window', () => {
    const b = auditContextBudget({
      systemPrompt: 'x'.repeat(350_000), // 100K tokens
      toolCount: 50,
      contextWindow: 32_000,
      tier: 'small'
    })
    assert.equal(b.availableForConversation, 0)
  })

  test('warningRatio is 0 when contextWindow is 0 (no divide-by-zero)', () => {
    const b = auditContextBudget({ systemPrompt: 'a', toolCount: 1, contextWindow: 0, tier: 'small' })
    assert.equal(b.warningRatio, 0)
  })

  test('breakdown string includes window and percentage', () => {
    const b = auditContextBudget({
      systemPrompt: 'abc',
      toolCount: 2,
      contextWindow: 128_000,
      tier: 'medium'
    })
    assert.ok(b.breakdown.includes('128K'))
    assert.ok(b.breakdown.includes('%'))
  })
})

describe('estimateToolCount', () => {
  test('explicit allowedTools list returns its length', () => {
    assert.equal(
      estimateToolCount({ allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: [], isLocalProvider: true }),
      3
    )
  })

  test('no allow-list returns 11 builtins minus disallowed builtins', () => {
    assert.equal(
      estimateToolCount({ disallowedTools: ['Write', 'Edit'], isLocalProvider: false }),
      9
    )
  })

  test('disallowed non-builtins do not reduce the count', () => {
    assert.equal(
      estimateToolCount({ disallowedTools: ['Agent', 'ToolSearch'], isLocalProvider: false }),
      11
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
