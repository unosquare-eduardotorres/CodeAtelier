/**
 * Tests for the ask_user structural guard — questions before plan, never after.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { evaluateAskUserGuard, ASK_USER_AFTER_PLAN_MESSAGE } from '../ask-user-guard'

describe('evaluateAskUserGuard', () => {
  test('allows ask_user when no plan has been emitted this turn (ask-then-plan)', () => {
    assert.equal(evaluateAskUserGuard(false), null)
  })

  test('rejects ask_user after a plan was emitted this turn (plan-then-ask)', () => {
    const rejection = evaluateAskUserGuard(true)
    assert.equal(rejection, ASK_USER_AFTER_PLAN_MESSAGE)
    assert.match(rejection ?? '', /BEFORE emit_plan/)
    assert.match(rejection ?? '', /never after/)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
