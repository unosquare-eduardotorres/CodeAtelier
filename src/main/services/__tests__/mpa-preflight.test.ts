/**
 * MPA Pre-flight Classifier — verifies goal classification and validation.
 *
 * Pure logic: no filesystem, no network, no Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { classifyGoal } from '../mpa-preflight.service'

describe('MPA Pre-flight Classifier', () => {
  // ── Valid Goals ──

  test('classifies feature goal', () => {
    const result = classifyGoal('Add user authentication with OAuth2 and JWT tokens')
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'feature')
    assert.deepEqual(result.phases, ['plan', 'execute', 'verify'])
  })

  test('classifies refactor goal', () => {
    const result = classifyGoal(
      'Refactor the payment module to use repository pattern for better testability'
    )
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'refactor')
    assert.deepEqual(result.phases, ['plan', 'execute', 'verify'])
  })

  test('classifies bugfix goal', () => {
    const result = classifyGoal(
      'Fix the login page crashing when users enter special characters in their password'
    )
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'bugfix')
  })

  test('classifies test goal', () => {
    const result = classifyGoal(
      'Add unit tests for all services in src/services with good coverage'
    )
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'tests')
    assert.deepEqual(result.phases, ['plan', 'execute'])
  })

  test('classifies migrate as refactor', () => {
    const result = classifyGoal('Migrate the database layer from Sequelize to Prisma')
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'refactor')
  })

  // ── Invalid Goals ──

  test('rejects too-short goals', () => {
    const result = classifyGoal('fix it')
    assert.equal(result.isValid, false)
    assert.ok(result.rejectionReason)
  })

  test('rejects vague goals', () => {
    const result = classifyGoal('make it better')
    assert.equal(result.isValid, false)
    assert.ok(result.rejectionReason?.includes('vague'))
  })

  test('rejects empty goals', () => {
    const result = classifyGoal('')
    assert.equal(result.isValid, false)
  })

  test('rejects goals over max length', () => {
    const result = classifyGoal('A'.repeat(50001))
    assert.equal(result.isValid, false)
    assert.ok(result.rejectionReason?.includes('long'))
  })

  // ── Suggestions ──

  test('provides suggestion for vague fix goal', () => {
    const result = classifyGoal('fix stuff')
    assert.equal(result.isValid, false)
    assert.ok(result.suggestedGoal)
  })

  // ── Edge cases ──

  test('handles goal with only test keyword but specific enough', () => {
    const result = classifyGoal(
      'Add integration tests for the user authentication flow including error cases'
    )
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'tests')
  })

  test('defaults to feature for ambiguous goals', () => {
    const result = classifyGoal(
      'Create a new dashboard page with charts showing sales data over time'
    )
    assert.equal(result.isValid, true)
    assert.equal(result.goalType, 'feature')
  })

  test('all valid goals return non-empty phases array', () => {
    const goals = [
      'Add user authentication with JWT tokens',
      'Refactor payment module to repository pattern',
      'Fix upload failing for files over 5MB',
      'Add unit tests for UserService and PaymentService'
    ]
    for (const goal of goals) {
      const result = classifyGoal(goal)
      assert.equal(result.isValid, true, `Goal "${goal}" should be valid`)
      assert.ok(result.phases.length > 0, `Goal "${goal}" should have phases`)
    }
  })
})
