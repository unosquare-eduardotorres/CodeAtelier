/**
 * Unit tests for cost-tracker.service — pure exported functions for token cost estimation.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 * Tests cover estimateCostCents, estimateCostFromTotal, and MODEL_PRICING table validation.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

const { estimateCostCents, estimateCostFromTotal, MODEL_PRICING } =
  require('../cost-tracker.service') as typeof import('../cost-tracker.service')

describe('CostTracker — estimateCostCents', () => {
  test('estimateCostCents_known_model_sonnet', () => {
    // sonnet pricing: inputPer1M=3.0, outputPer1M=15.0
    // 1M input = 3.0 * 100 = 300 cents, 1M output = 15.0 * 100 = 1500 cents
    const result = estimateCostCents(1_000_000, 1_000_000, 'claude-sonnet-4-6')
    assert.equal(result, 1800)
  })

  test('estimateCostCents_known_model_opus', () => {
    // opus-4-8 pricing: inputPer1M=5.0, outputPer1M=25.0
    // 1M input = 5.0 * 100 = 500 cents, 1M output = 25.0 * 100 = 2500 cents
    const result = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-8')
    assert.equal(result, 3000)
  })

  test('estimateCostCents_known_model_haiku', () => {
    // haiku pricing: inputPer1M=1.0, outputPer1M=5.0
    // 1M input = 1.0 * 100 = 100 cents, 1M output = 5.0 * 100 = 500 cents
    const result = estimateCostCents(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001')
    assert.equal(result, 600)
  })

  test('estimateCostCents_unknown_model_uses_default', () => {
    // Unknown model → defaults to sonnet-like pricing (3.0 / 15.0)
    const result = estimateCostCents(1_000_000, 1_000_000, 'claude-unknown-99')
    assert.equal(result, 1800, 'Unknown model should fall back to default (sonnet) pricing')
  })

  test('estimateCostCents_zero_tokens_returns_zero', () => {
    const result = estimateCostCents(0, 0, 'claude-sonnet-4-6')
    assert.equal(result, 0)
  })

  test('estimateCostCents_no_model_uses_default', () => {
    // No modelId → default pricing (same as sonnet: 3.0 / 15.0)
    const result = estimateCostCents(1_000_000, 1_000_000)
    assert.equal(result, 1800)
  })

  test('estimateCostCents_small_token_counts_rounds_correctly', () => {
    // 1000 input + 500 output with sonnet pricing:
    // inputCost = (1000/1M) * 3.0 = 0.003
    // outputCost = (500/1M) * 15.0 = 0.0075
    // total $ = 0.0105, in cents = 1.05, rounded = 1
    const result = estimateCostCents(1000, 500, 'claude-sonnet-4-6')
    assert.equal(result, Math.round(1.05))
  })
})

describe('CostTracker — estimateCostFromTotal', () => {
  test('estimateCostFromTotal_splits_75_25', () => {
    // 1M total → 750K input + 250K output (sonnet: 3.0 / 15.0)
    // inputCost = (750000/1M) * 3.0 = 2.25
    // outputCost = (250000/1M) * 15.0 = 3.75
    // total $ = 6.0, in cents = 600
    const result = estimateCostFromTotal(1_000_000, 'claude-sonnet-4-6')
    assert.equal(result, 600)
  })

  test('estimateCostFromTotal_zero_returns_zero', () => {
    const result = estimateCostFromTotal(0, 'claude-sonnet-4-6')
    assert.equal(result, 0)
  })
})

describe('CostTracker — MODEL_PRICING', () => {
  test('MODEL_PRICING_contains_expected_models', () => {
    const expectedModels = [
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-opus-4-6',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022'
    ]

    for (const model of expectedModels) {
      assert.ok(MODEL_PRICING[model], `Missing pricing for model: ${model}`)
      assert.equal(
        typeof MODEL_PRICING[model].inputPer1M,
        'number',
        `${model} inputPer1M should be a number`
      )
      assert.equal(
        typeof MODEL_PRICING[model].outputPer1M,
        'number',
        `${model} outputPer1M should be a number`
      )
      assert.ok(MODEL_PRICING[model].inputPer1M > 0, `${model} inputPer1M should be positive`)
      assert.ok(MODEL_PRICING[model].outputPer1M > 0, `${model} outputPer1M should be positive`)
    }

    // Verify no unexpected models snuck in without proper structure
    for (const [key, value] of Object.entries(MODEL_PRICING)) {
      const pricing = value as { inputPer1M: number; outputPer1M: number }
      assert.equal(typeof pricing.inputPer1M, 'number', `${key} has invalid inputPer1M`)
      assert.equal(typeof pricing.outputPer1M, 'number', `${key} has invalid outputPer1M`)
    }
  })
})
