/**
 * Blueprint Verify Goal Conditions — unit tests.
 *
 * Covers buildVerifyGoalCondition: content validation, title truncation,
 * 4-level methodology terms, anti-pattern references, and human verification.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { buildVerifyGoalCondition } from '../blueprint-goal-conditions'

describe('buildVerifyGoalCondition', () => {
  test('includes title truncated to 150 chars', () => {
    const longTitle = 'A'.repeat(200)
    const result = buildVerifyGoalCondition(longTitle)
    assert.ok(result.includes('A'.repeat(150)))
    assert.ok(!result.includes('A'.repeat(151)))
  })

  test('includes adversarial/4-level methodology terms', () => {
    const result = buildVerifyGoalCondition('Test Blueprint')
    assert.ok(result.includes('Adversarial verification'))
    assert.ok(result.includes('EXISTS'))
    assert.ok(result.includes('SUBSTANTIVE'))
    assert.ok(result.includes('WIRED'))
    assert.ok(result.includes('DATA FLOWING'))
    assert.ok(result.includes('4-level methodology'))
  })

  test('includes anti-pattern scan reference', () => {
    const result = buildVerifyGoalCondition('Test')
    assert.ok(result.includes('Anti-pattern scan'))
    assert.ok(result.includes('TODO/FIXME'))
  })

  test('includes human verification reference', () => {
    const result = buildVerifyGoalCondition('Test')
    assert.ok(result.includes('Human verification'))
  })

  test('returns non-empty string > 50 chars', () => {
    const result = buildVerifyGoalCondition('Minimal')
    assert.ok(typeof result === 'string')
    assert.ok(result.length > 50, `Expected > 50 chars, got ${result.length}`)
  })

  test('includes blueprint title in output', () => {
    const result = buildVerifyGoalCondition('My Feature Blueprint')
    assert.ok(result.includes('My Feature Blueprint'))
  })

  test('includes phase completion block reference', () => {
    const result = buildVerifyGoalCondition('Test')
    assert.ok(result.includes('blueprint-phase-complete'))
    assert.ok(result.includes('phase: "verify"'))
    assert.ok(result.includes('overallStatus'))
  })

  test('includes key links tracing reference', () => {
    const result = buildVerifyGoalCondition('Test')
    assert.ok(result.includes('Key links'))
    assert.ok(result.includes('traced and validated'))
  })

  test('includes spec requirement tracing reference', () => {
    const result = buildVerifyGoalCondition('Test')
    assert.ok(result.includes('spec requirement'))
    assert.ok(result.includes('implemented code'))
  })
})

// Only run summary when executed standalone
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
