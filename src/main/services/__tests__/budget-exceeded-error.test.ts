/**
 * Unit tests for shared/errors.ts — BudgetExceededError class.
 *
 * Covers constructor, message formatting, property storage, and inheritance.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BudgetExceededError } from '../../../shared/errors'

describe('BudgetExceededError', () => {
  test('daily scope message includes "Daily budget exceeded"', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-1',
      currentCostCents: 150,
      budgetCents: 200,
      scope: 'daily'
    })
    assert.ok(err.message.includes('Daily budget exceeded'))
  })

  test('session scope message includes "Session budget exceeded"', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-2',
      currentCostCents: 500,
      budgetCents: 400,
      scope: 'session'
    })
    assert.ok(err.message.includes('Session budget exceeded'))
  })

  test('stores workspaceId, currentCostCents, budgetCents, scope', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-abc',
      currentCostCents: 350,
      budgetCents: 300,
      scope: 'daily'
    })
    assert.equal(err.workspaceId, 'ws-abc')
    assert.equal(err.currentCostCents, 350)
    assert.equal(err.budgetCents, 300)
    assert.equal(err.scope, 'daily')
  })

  test('formats dollar amounts correctly ($1.50 / $2.00)', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-1',
      currentCostCents: 150,
      budgetCents: 200,
      scope: 'daily'
    })
    assert.ok(err.message.includes('$1.50'))
    assert.ok(err.message.includes('$2.00'))
  })

  test('name property is "BudgetExceededError"', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-1',
      currentCostCents: 0,
      budgetCents: 100,
      scope: 'session'
    })
    assert.equal(err.name, 'BudgetExceededError')
  })

  test('instanceof Error returns true', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-1',
      currentCostCents: 0,
      budgetCents: 100,
      scope: 'daily'
    })
    assert.ok(err instanceof Error)
    assert.ok(err instanceof BudgetExceededError)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
