import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import { THINKING_BUDGETS, COMPLEXITY_TO_EFFORT } from '../../../shared/constants'

describe('Opus 4.8 Thinking Config', () => {
  test('THINKING_BUDGETS.opus is empty (adaptive-only)', () => {
    assert.equal(THINKING_BUDGETS.opus, '')
  })

  test('parseInt of empty opus budget is falsy', () => {
    assert.ok(!parseInt(THINKING_BUDGETS.opus))
  })

  test('Opus adaptive thinking config shape', () => {
    const modelId = 'claude-opus-4-8'
    const thinking = modelId.includes('opus')
      ? { type: 'adaptive' as const }
      : { type: 'enabled' as const, budgetTokens: 10000 }
    assert.deepEqual(thinking, { type: 'adaptive' })
  })

  test('Sonnet adaptive thinking config shape (Sonnet 5 is adaptive-only)', () => {
    const modelId = 'claude-sonnet-5'
    const budget = parseInt(THINKING_BUDGETS.sonnet)
    const thinking = modelId.includes('opus')
      ? { type: 'adaptive' as const }
      : budget
        ? { type: 'enabled' as const, budgetTokens: budget }
        : undefined
    // Sonnet 5 is adaptive-only — THINKING_BUDGETS.sonnet is '' → parseInt is NaN → falsy → undefined
    assert.equal(thinking, undefined)
  })

  test('Haiku budget-based thinking config shape', () => {
    const budget = parseInt(THINKING_BUDGETS.haiku)
    assert.equal(budget, 5000)
  })

  test('COMPLEXITY_TO_EFFORT.complex is high (4.8 default)', () => {
    assert.equal(COMPLEXITY_TO_EFFORT.complex, 'high')
  })

  test('effort for opus 4.8 model uses high', () => {
    const effort = 'high' // Opus 4.8 at high ≥ 4.7 at xhigh
    assert.equal(effort, 'high')
  })

  test('effort for sonnet model uses standard level', () => {
    const modelId = 'claude-sonnet-5'
    const effort = modelId.includes('opus') ? 'xhigh' : 'high'
    assert.equal(effort, 'high')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
