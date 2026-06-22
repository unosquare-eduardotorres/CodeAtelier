/**
 * Unit tests for cost-tracker.service.ts — expanded edge cases for pricing.
 *
 * Supplements the existing cost-tracker.test.ts with edge cases:
 * legacy models, very large token counts, undefined model, boundary rounding.
 *
 * Phase 4D — ~10 tests. All pure logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

const { estimateCostCents, estimateCostFromTotal, MODEL_PRICING } =
  require('../cost-tracker.service') as typeof import('../cost-tracker.service')

describe('CostTracker — pricing edge cases', () => {
  test('fable-5 → most expensive current model', () => {
    // Fable 5 pricing: inputPer1M=10.0, outputPer1M=50.0
    // 1M input = 10.0 * 100 = 1000 cents, 1M output = 50.0 * 100 = 5000 cents
    const result = estimateCostCents(1_000_000, 1_000_000, 'claude-fable-5')
    assert.equal(result, 6000)
    // More expensive than Opus 4.8
    const opusCost = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-8')
    assert.ok(result > opusCost, 'Fable 5 should be more expensive than Opus 4.8')
  })

  test('legacy opus-4-20250514 → higher pricing than opus-4-8', () => {
    // Legacy opus-4-20250514: input=15.0, output=75.0 (much higher)
    const legacyCost = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-20250514')
    const currentCost = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-8')
    assert.ok(legacyCost > currentCost, 'Legacy opus should be more expensive')
    // Legacy: 15 + 75 = 90 * 100 = 9000 cents
    assert.equal(legacyCost, 9000)
  })

  test('legacy haiku-20241022 → slightly cheaper than current haiku', () => {
    const legacyCost = estimateCostCents(1_000_000, 1_000_000, 'claude-3-5-haiku-20241022')
    const currentCost = estimateCostCents(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001')
    assert.ok(legacyCost < currentCost, 'Legacy haiku should be cheaper')
    // Legacy: 0.8 + 4.0 = 4.8 * 100 = 480 cents
    assert.equal(legacyCost, 480)
  })

  test('very large token counts do not overflow', () => {
    // 1 billion tokens each
    const result = estimateCostCents(1_000_000_000, 1_000_000_000, 'claude-sonnet-4-6')
    // 1000 * 3.0 + 1000 * 15.0 = 3000 + 15000 = 18000 * 100 = 1,800,000 cents
    assert.equal(result, 1_800_000)
  })

  test('undefined modelId → same as default (sonnet-like)', () => {
    const withUndefined = estimateCostCents(1_000_000, 1_000_000, undefined)
    const withDefault = estimateCostCents(1_000_000, 1_000_000)
    assert.equal(withUndefined, withDefault)
  })

  test('empty string modelId → falls back to default', () => {
    const result = estimateCostCents(1_000_000, 1_000_000, '')
    // Empty string not in MODEL_PRICING → default pricing (3.0 / 15.0)
    assert.equal(result, 1800)
  })

  test('only input tokens (no output) → correct calculation', () => {
    // 1M input, 0 output with haiku: 1.0 * 100 = 100 cents
    const result = estimateCostCents(1_000_000, 0, 'claude-haiku-4-5-20251001')
    assert.equal(result, 100)
  })

  test('only output tokens (no input) → correct calculation', () => {
    // 0 input, 1M output with haiku: 5.0 * 100 = 500 cents
    const result = estimateCostCents(0, 1_000_000, 'claude-haiku-4-5-20251001')
    assert.equal(result, 500)
  })
})

describe('CostTracker — estimateCostFromTotal edge cases', () => {
  test('75/25 split matches manual calculation', () => {
    // 4M total → 3M input + 1M output (sonnet: 3.0 / 15.0)
    // inputCost = 3.0 * 3 = 9.0, outputCost = 15.0 * 1 = 15.0
    // total = 24.0 * 100 = 2400 cents
    const result = estimateCostFromTotal(4_000_000, 'claude-sonnet-4-6')
    assert.equal(result, 2400)
  })

  test('estimateCostFromTotal matches manual estimateCostCents for same split', () => {
    const total = 1_000_000
    const fromTotal = estimateCostFromTotal(total, 'claude-opus-4-8')

    // Manual split: 75% = 750000, 25% = 250000
    const manual = estimateCostCents(
      Math.round(total * 0.75),
      Math.round(total * 0.25),
      'claude-opus-4-8'
    )
    assert.equal(fromTotal, manual)
  })

  test('small total (100 tokens) → rounds to 0', () => {
    // 100 * 0.75 = 75 input, 100 * 0.25 = 25 output
    // inputCost = (75/1M) * 3.0 ≈ 0.000225
    // outputCost = (25/1M) * 15.0 ≈ 0.000375
    // total ≈ 0.0006 * 100 = 0.06 → rounds to 0
    const result = estimateCostFromTotal(100, 'claude-sonnet-4-6')
    assert.equal(result, 0)
  })
})

describe('CostTracker — MODEL_PRICING completeness', () => {
  test('all models have positive pricing values', () => {
    for (const [modelId, pricing] of Object.entries(MODEL_PRICING)) {
      const p = pricing as { inputPer1M: number; outputPer1M: number }
      assert.ok(p.inputPer1M > 0, `${modelId} inputPer1M must be positive`)
      assert.ok(p.outputPer1M > 0, `${modelId} outputPer1M must be positive`)
      assert.ok(
        p.outputPer1M >= p.inputPer1M,
        `${modelId} output should be >= input price`
      )
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
