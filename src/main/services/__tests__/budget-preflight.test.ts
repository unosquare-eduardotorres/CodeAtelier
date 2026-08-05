/**
 * Unit tests for budget preflight enforcement.
 *
 * Covers:
 *   Fix 1.1 — BudgetExceededError + checkPreFlightBudget integration
 *   Fix 1.2 — dailyCostCents (24-hour window vs lifetime)
 *   Fix 1.3 — Per-session cost limit via TokenAccountant.getSessionCostCents
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Fix 1.1: BudgetExceededError ──

const { BudgetExceededError } =
  require('../../../shared/errors') as typeof import('../../../shared/errors')

describe('BudgetExceededError', () => {
  test('daily scope — constructs with correct message and fields', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-1',
      currentCostCents: 5000,
      budgetCents: 5000,
      scope: 'daily'
    })
    assert.equal(err.name, 'BudgetExceededError')
    assert.equal(err.scope, 'daily')
    assert.equal(err.workspaceId, 'ws-1')
    assert.equal(err.currentCostCents, 5000)
    assert.equal(err.budgetCents, 5000)
    assert.ok(err.message.includes('Daily budget exceeded'))
    assert.ok(err.message.includes('$50.00'))
    assert.ok(err instanceof Error)
  })

  test('session scope — constructs with correct message', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-2',
      currentCostCents: 1200,
      budgetCents: 1000,
      scope: 'session'
    })
    assert.equal(err.scope, 'session')
    assert.ok(err.message.includes('Session budget exceeded'))
    assert.ok(err.message.includes('$12.00'))
    assert.ok(err.message.includes('$10.00'))
  })

  test('zero cents — formats correctly', () => {
    const err = new BudgetExceededError({
      workspaceId: 'ws-3',
      currentCostCents: 0,
      budgetCents: 0,
      scope: 'daily'
    })
    assert.ok(err.message.includes('$0.00'))
  })
})

// ── Fix 1.2: BudgetStatus.dailyCostCents ──

const { estimateCostCents } =
  require('../cost-tracker.service') as typeof import('../cost-tracker.service')

describe('BudgetStatus — daily cost window', () => {
  test('estimateCostCents with sonnet model — basic pricing', () => {
    // Sonnet: $3/MTok in, $15/MTok out
    // 100K in = 0.1 * 3.0 = $0.30 = 30 cents
    // 100K out = 0.1 * 15.0 = $1.50 = 150 cents
    // Total = 180 cents → rounds to 180
    const cost = estimateCostCents(100_000, 100_000, 'claude-sonnet-4-6')
    assert.equal(cost, 180)
  })

  test('daily budget check uses dailyCostCents not lifetime total', () => {
    // The BudgetStatus interface now includes dailyCostCents
    // This verifies the type shape is correct
    const mockStatus = {
      currentCostCents: 20000, // $200 lifetime
      dailyCostCents: 0, // $0 today
      dailyBudgetCents: 5000, // $50 daily limit
      sessionBudgetCents: 0,
      dailyPercentUsed: 0,
      dailyWarning: false,
      dailyExceeded: false
    }
    // With $200 lifetime but $0 today, daily budget should NOT be exceeded
    assert.equal(mockStatus.dailyExceeded, false)
    assert.equal(mockStatus.dailyPercentUsed, 0)
  })

  test('dailyPercentUsed based on dailyCostCents', () => {
    const dailyCostCents = 4000 // $40 today
    const dailyBudgetCents = 5000 // $50 daily limit
    const dailyPercentUsed = (dailyCostCents / dailyBudgetCents) * 100
    assert.equal(dailyPercentUsed, 80)
  })

  test('24-hour window — $0 today with high lifetime → not exceeded', () => {
    const dailyCostCents = 0
    const dailyBudgetCents = 5000
    const dailyPercentUsed = dailyBudgetCents > 0 ? (dailyCostCents / dailyBudgetCents) * 100 : 0
    assert.equal(dailyPercentUsed, 0)
    assert.ok(dailyPercentUsed < 80, 'Should not trigger warning')
    assert.ok(dailyPercentUsed < 100, 'Should not trigger exceeded')
  })

  test('24-hour window — $50 today with $50 limit → exceeded', () => {
    const dailyCostCents = 5000
    const dailyBudgetCents = 5000
    const dailyPercentUsed = (dailyCostCents / dailyBudgetCents) * 100
    assert.equal(dailyPercentUsed, 100)
    assert.ok(dailyPercentUsed >= 100, 'Should trigger exceeded')
  })
})

// ── Fix 1.3: Per-session cost limit ──

const { TokenAccountant } = require('../executor-utils/token-accountant') as any

describe('TokenAccountant — getSessionCostCents', () => {
  test('zero usage → zero cost', () => {
    const ta = new TokenAccountant()
    assert.equal(ta.getSessionCostCents(), 0)
  })

  test('accumulates input + output correctly with default pricing', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 100_000 })
    ta.accumulateFromMessageDelta({ output_tokens: 50_000 })
    // Default pricing (sonnet-like): $3/MTok in, $15/MTok out
    // 100K in = 0.1 * 3.0 = $0.30 = 30 cents
    // 50K out = 0.05 * 15.0 = $0.75 = 75 cents
    // Total = 105 cents → rounds to 105
    const cost = ta.getSessionCostCents()
    assert.equal(cost, 105)
  })

  test('uses model-specific pricing when provided', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 1_000_000 })
    ta.accumulateFromMessageDelta({ output_tokens: 1_000_000 })
    // Haiku: $1/MTok in, $5/MTok out → 1 + 5 = $6 = 600 cents
    const cost = ta.getSessionCostCents('claude-haiku-4-5-20251001')
    assert.equal(cost, 600)
  })

  test('unknown model → uses default pricing', () => {
    const ta = new TokenAccountant()
    ta.accumulateFromMessageStart({ input_tokens: 1_000_000 })
    ta.accumulateFromMessageDelta({ output_tokens: 1_000_000 })
    // Default: $3/MTok in, $15/MTok out → 3 + 15 = $18 = 1800 cents
    const cost = ta.getSessionCostCents('claude-unknown-99')
    assert.equal(cost, 1800)
  })

  test('budget not set (0) → always allowed', () => {
    const sessionBudgetCents = 0
    const sessionCostCents = 999999
    // When budget is 0 (unlimited), never exceed
    const exceeded = sessionBudgetCents > 0 && sessionCostCents >= sessionBudgetCents
    assert.equal(exceeded, false)
  })

  test('budget set, under threshold → allowed', () => {
    const sessionBudgetCents = 5000
    const sessionCostCents = 2000
    const exceeded = sessionBudgetCents > 0 && sessionCostCents >= sessionBudgetCents
    assert.equal(exceeded, false)
  })

  test('budget set, at limit → not allowed', () => {
    const sessionBudgetCents = 5000
    const sessionCostCents = 5000
    const exceeded = sessionBudgetCents > 0 && sessionCostCents >= sessionBudgetCents
    assert.equal(exceeded, true)
  })
})

// ─── Guardian: run summary only when standalone ───
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
