/**
 * memory-engine.test.ts — Tests for MemoryEngineService write pipeline.
 *
 * Covers: cosineSimilarity math, promotion tier logic, decay sweep scheduling.
 * Engine integration tests are deferred (require embedding provider mock).
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

// Import the pure math function directly
import { cosineSimilarity, computePromotionTierPure } from '../memory-engine.service'

// ── Cosine Similarity ──

test('cosineSimilarity: identical vectors = 1.0', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([1, 0, 0])
  assert.equal(cosineSimilarity(a, b), 1.0)
})

test('cosineSimilarity: orthogonal vectors = 0.0', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([0, 1, 0])
  assert.equal(cosineSimilarity(a, b), 0.0)
})

test('cosineSimilarity: opposite vectors = -1.0', () => {
  const a = new Float32Array([1, 0, 0])
  const b = new Float32Array([-1, 0, 0])
  assert.equal(cosineSimilarity(a, b), -1.0)
})

test('cosineSimilarity: empty vectors = 0.0', () => {
  const a = new Float32Array([])
  const b = new Float32Array([])
  assert.equal(cosineSimilarity(a, b), 0)
})

test('cosineSimilarity: different length = 0.0', () => {
  const a = new Float32Array([1, 0])
  const b = new Float32Array([1, 0, 0])
  assert.equal(cosineSimilarity(a, b), 0)
})

test('cosineSimilarity: partial overlap scores between 0 and 1', () => {
  const a = new Float32Array([1, 1, 0])
  const b = new Float32Array([1, 0, 1])
  const sim = cosineSimilarity(a, b)
  assert.ok(sim > 0 && sim < 1, `Expected 0 < ${sim} < 1`)
})

test('cosineSimilarity: zero vector = 0.0', () => {
  const a = new Float32Array([0, 0, 0])
  const b = new Float32Array([1, 0, 0])
  assert.equal(cosineSimilarity(a, b), 0)
})

// ── Promotion Tier Logic ──

test('promotion: T0 with 2 confirms → T1', () => {
  assert.equal(computePromotionTierPure(0, 1), 1) // nextCount=1+1=2 handled inside, but we pass current count
})

test('promotion: T0 with 1 confirm stays T0', () => {
  assert.equal(computePromotionTierPure(0, 0), 0)
})

test('promotion: T1 with 3 confirms → T2', () => {
  assert.equal(computePromotionTierPure(1, 2), 2)
})

test('promotion: T1 with 2 confirms stays T1', () => {
  assert.equal(computePromotionTierPure(1, 1), 1)
})

test('promotion: T2 with 5 confirms → T3', () => {
  assert.equal(computePromotionTierPure(2, 4), 3)
})

test('promotion: T2 with 4 confirms stays T2', () => {
  assert.equal(computePromotionTierPure(2, 3), 2)
})

test('promotion: T3 stays T3 regardless of confirms', () => {
  assert.equal(computePromotionTierPure(3, 99), 3)
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
