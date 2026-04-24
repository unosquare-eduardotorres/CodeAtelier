/**
 * Unit tests for complexity-scorer.service — pure functions for task complexity scoring,
 * tier classification, model resolution, and task enrichment.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 * 100% pure functions, zero external dependencies — simplest test file in the batch.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

const {
  getTierFromScore,
  validateComplexityScore,
  resolveModel,
  enrichTasksWithComplexity
} = require('../complexity-scorer.service') as typeof import('../complexity-scorer.service')

describe('ComplexityScorer — getTierFromScore', () => {
  test('getTierFromScore_simple_threshold', () => {
    assert.equal(getTierFromScore(0), 'simple')
    assert.equal(getTierFromScore(1), 'simple')
    assert.equal(getTierFromScore(3), 'simple')
    assert.equal(getTierFromScore(4), 'simple')
  })

  test('getTierFromScore_moderate_threshold', () => {
    assert.equal(getTierFromScore(5), 'moderate')
    assert.equal(getTierFromScore(6), 'moderate')
    assert.equal(getTierFromScore(7), 'moderate')
    assert.equal(getTierFromScore(8), 'moderate')
  })

  test('getTierFromScore_complex_threshold', () => {
    assert.equal(getTierFromScore(9), 'complex')
    assert.equal(getTierFromScore(10), 'complex')
    assert.equal(getTierFromScore(15), 'complex')
  })

  test('getTierFromScore_boundary_values', () => {
    assert.equal(getTierFromScore(4), 'simple', '4 should be simple (upper bound)')
    assert.equal(getTierFromScore(5), 'moderate', '5 should be moderate (lower bound)')
    assert.equal(getTierFromScore(8), 'moderate', '8 should be moderate (upper bound)')
    assert.equal(getTierFromScore(9), 'complex', '9 should be complex (lower bound)')
  })
})

describe('ComplexityScorer — validateComplexityScore', () => {
  test('validateComplexityScore_normalizes_valid_input', () => {
    const raw = {
      filesAffected: 2,
      estimatedLines: 2,
      newDependencies: 1,
      taskType: 2,
      riskFlags: 1
    }
    const result = validateComplexityScore(raw)
    assert.equal(result.filesAffected, 2)
    assert.equal(result.estimatedLines, 2)
    assert.equal(result.newDependencies, 1)
    assert.equal(result.taskType, 2)
    assert.equal(result.riskFlags, 1)
    assert.equal(result.total, 8) // 2+2+1+2+1
    assert.equal(result.tier, 'moderate')
    assert.equal(result.model, 'sonnet')
  })

  test('validateComplexityScore_falls_back_on_undefined', () => {
    const result = validateComplexityScore(undefined)
    assert.equal(result.total, 5)
    assert.equal(result.tier, 'moderate')
    assert.equal(result.model, 'sonnet')
  })

  test('validateComplexityScore_clamps_out_of_range_values', () => {
    const raw = {
      filesAffected: 10, // max 3 → clamped
      estimatedLines: -5, // min 0 → clamped
      newDependencies: 99, // max 2 → clamped
      taskType: 3,
      riskFlags: 3
    }
    const result = validateComplexityScore(raw)
    assert.equal(result.filesAffected, 3, 'filesAffected should clamp to 3')
    assert.equal(result.estimatedLines, 0, 'negative estimatedLines should clamp to 0')
    assert.equal(result.newDependencies, 2, 'newDependencies should clamp to 2')
    assert.equal(result.total, 3 + 0 + 2 + 3 + 3) // 11
    assert.equal(result.tier, 'complex')
    assert.equal(result.model, 'opus')
  })
})

describe('ComplexityScorer — resolveModel', () => {
  test('resolveModel_economy_always_haiku', () => {
    // Even a complex score should return haiku in economy mode
    const complex = validateComplexityScore({ filesAffected: 3, estimatedLines: 3, newDependencies: 2, taskType: 3, riskFlags: 3 })
    assert.equal(resolveModel(complex, 'economy'), 'haiku')

    const simple = validateComplexityScore({ filesAffected: 0, estimatedLines: 0, newDependencies: 0, taskType: 0, riskFlags: 0 })
    assert.equal(resolveModel(simple, 'economy'), 'haiku')
  })

  test('resolveModel_power_always_opus', () => {
    // Even a simple score should return opus in power mode
    const simple = validateComplexityScore({ filesAffected: 0, estimatedLines: 0, newDependencies: 0, taskType: 0, riskFlags: 0 })
    assert.equal(resolveModel(simple, 'power'), 'opus')

    const complex = validateComplexityScore({ filesAffected: 3, estimatedLines: 3, newDependencies: 2, taskType: 3, riskFlags: 3 })
    assert.equal(resolveModel(complex, 'power'), 'opus')
  })
})

describe('ComplexityScorer — enrichTasksWithComplexity', () => {
  test('enrichTasksWithComplexity_applies_to_all_tasks', () => {
    const tasks = [
      { id: 't1', title: 'Simple task', description: '', specialist: 'test' },
      { id: 't2', title: 'Medium task', description: '', specialist: 'test' },
      { id: 't3', title: 'Complex task', description: '', specialist: 'test' }
    ] as any[]

    const enriched = enrichTasksWithComplexity(tasks, 'balanced')
    assert.equal(enriched.length, 3)

    for (const task of enriched) {
      // Each task should have a valid complexity score
      assert.ok(task.complexity, `Task ${task.id} should have complexity`)
      assert.ok(typeof task.complexity.total === 'number', `Task ${task.id} should have numeric total`)
      assert.ok(['simple', 'moderate', 'complex'].includes(task.complexity.tier), `Task ${task.id} should have valid tier`)
      // Each task should have a resolved model
      assert.ok(['haiku', 'sonnet', 'opus'].includes(task.model), `Task ${task.id} should have valid model`)
    }
  })
})
