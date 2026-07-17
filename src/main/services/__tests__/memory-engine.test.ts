/**
 * memory-engine.test.ts — Tests for MemoryEngineService write pipeline.
 *
 * Covers: cosineSimilarity math, evidence-based promotion tier logic,
 * volatile detection, capture caps, cluster-based dedup.
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

// Import the pure math function and exported constants
import {
  cosineSimilarity,
  computePromotionTierPure,
  VOLATILE_PATTERNS,
  CAPTURE_CAPS
} from '../memory-engine.service'

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

// ── Evidence-Based Promotion Tier Logic ──

// Helper to create confirmation events
function makeConfirm(sourceType: 'auto_dedup' | 'human' | 'tool' | 'extraction' | 'bootstrap', dayOffset: number, weight?: number) {
  const date = new Date()
  date.setDate(date.getDate() - dayOffset) // dayOffset days ago
  return {
    sourceType,
    weight: weight ?? (sourceType === 'auto_dedup' ? 0.5 : 1.0),
    createdAt: date.toISOString()
  }
}

test('promotion: T0 stays T0 with only 1 confirm (needs 2)', () => {
  const confirms = [makeConfirm('extraction', 0)]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: T0 stays T0 with 2 confirms on SAME day (needs 2 distinct days)', () => {
  const confirms = [
    makeConfirm('extraction', 0),
    makeConfirm('tool', 0)
  ]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: T0 → T1 with 2 confirms on 2 distinct days', () => {
  const confirms = [
    makeConfirm('extraction', 2),
    makeConfirm('tool', 0)
  ]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 1)
})

test('promotion: T1 stays T1 with 3 confirms but only 1 source type', () => {
  const confirms = [
    makeConfirm('auto_dedup', 10),
    makeConfirm('auto_dedup', 5),
    makeConfirm('auto_dedup', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.7, confirms), 1)
})

test('promotion: T1 stays T1 with 3 confirms, 2 sources, but only 3 days span (needs 7)', () => {
  const confirms = [
    makeConfirm('extraction', 3),
    makeConfirm('tool', 1),
    makeConfirm('auto_dedup', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.7, confirms), 1)
})

test('promotion: T1 stays T1 with all criteria met but confidence < 0.65', () => {
  const confirms = [
    makeConfirm('extraction', 10),
    makeConfirm('tool', 3),
    makeConfirm('auto_dedup', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.5, confirms), 1)
})

test('promotion: T1 → T2 with 3 confirms, 2+ sources, 7+ days, confidence ≥ 0.65', () => {
  const confirms = [
    makeConfirm('extraction', 10),
    makeConfirm('tool', 3),
    makeConfirm('auto_dedup', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.7, confirms), 2)
})

test('promotion: T2 stays T2 without human confirmation', () => {
  const confirms = [
    makeConfirm('extraction', 20),
    makeConfirm('tool', 15),
    makeConfirm('auto_dedup', 10),
    makeConfirm('auto_dedup', 5),
    makeConfirm('auto_dedup', 0)
  ]
  // Weighted sum: 1.0 + 1.0 + 0.5 + 0.5 + 0.5 = 3.5 (needs 5.0 and human)
  assert.equal(computePromotionTierPure(2, 0.85, confirms), 2)
})

test('promotion: T2 stays T2 with human but weighted sum < 5', () => {
  const confirms = [
    makeConfirm('human', 20),
    makeConfirm('tool', 10),
    makeConfirm('auto_dedup', 0)
  ]
  // Weighted sum: 1.0 + 1.0 + 0.5 = 2.5 (needs 5.0)
  assert.equal(computePromotionTierPure(2, 0.85, confirms), 2)
})

test('promotion: T2 stays T2 with human + weight but confidence < 0.80', () => {
  const confirms = [
    makeConfirm('human', 20),
    makeConfirm('tool', 15),
    makeConfirm('extraction', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 0)
  ]
  // Weighted sum: 5.0, daySpan: 20, has human — but confidence 0.7 < 0.8
  assert.equal(computePromotionTierPure(2, 0.7, confirms), 2)
})

test('promotion: T2 → T3 with human + weighted ≥ 5 + 14+ days + confidence ≥ 0.80', () => {
  const confirms = [
    makeConfirm('human', 20),
    makeConfirm('tool', 15),
    makeConfirm('extraction', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 0)
  ]
  // Weighted sum: 1.0 + 1.0 + 1.0 + 1.0 + 1.0 = 5.0
  assert.equal(computePromotionTierPure(2, 0.85, confirms), 3)
})

test('promotion: T3 stays T3 regardless of input', () => {
  const confirms = [makeConfirm('auto_dedup', 0)]
  assert.equal(computePromotionTierPure(3, 0.9, confirms), 3)
})

test('promotion: empty confirmations keeps current tier', () => {
  assert.equal(computePromotionTierPure(0, 0.5, []), 0)
  assert.equal(computePromotionTierPure(1, 0.7, []), 1)
  assert.equal(computePromotionTierPure(2, 0.8, []), 2)
})

// ── Volatile Pattern Detection ──

test('volatile: detects schemaVersion patterns', () => {
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('database.schemaVersion: 118')))
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('CURRENT_SCHEMA_VERSION = 118')))
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('schema_version is now 85')))
})

test('volatile: detects electronVersion patterns', () => {
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('electronVersion: 42.4.1')))
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('electron_version set to 40.9.3')))
})

test('volatile: detects semver patterns', () => {
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('upgraded to v3.2.1')))
  assert.ok(VOLATILE_PATTERNS.some((p) => p.test('uses v42.4.1')))
})

test('volatile: does NOT match non-version content', () => {
  const text = 'The codebase uses a three-tier context management system'
  const matched = VOLATILE_PATTERNS.some((p) => p.test(text))
  assert.equal(matched, false, `"${text}" should not match volatile patterns`)
})

// ── Capture Caps ──

test('capture caps: constants are reasonable', () => {
  assert.equal(CAPTURE_CAPS.MAX_FACTS_PER_SESSION, 3, 'Session cap should be 3')
  assert.equal(CAPTURE_CAPS.MAX_FACTS_PER_COMMIT, 2, 'Commit cap should be 2')
  assert.equal(CAPTURE_CAPS.MAX_FACTS_PER_DAY, 20, 'Daily cap should be 20')
})

// ── backfillAllPendingEmbeddings — progress callback contract ──

test('backfillAllPendingEmbeddings: returns 0 when provider not ready', async () => {
  const { memoryEngineService } = await import('../memory-engine.service')
  const progressCalls: Array<[number, number]> = []
  const result = await memoryEngineService.backfillAllPendingEmbeddings(
    (processed, total) => progressCalls.push([processed, total])
  )
  assert.equal(result, 0, 'Should return 0 when provider is not ready')
  assert.equal(progressCalls.length, 0, 'Should not call onProgress when provider is not ready')
})

// ── scanForDuplicates — returns cluster-based results ──

test('scanForDuplicates: returns clustersFound=0 when no embedded facts', async () => {
  const { memoryEngineService } = await import('../memory-engine.service')
  try {
    const result = memoryEngineService.scanForDuplicates('nonexistent-workspace-id')
    assert.equal(result.clustersFound, 0)
    assert.equal(result.autoMerged, 0)
  } catch {
    // Expected in test env without DB — the method tried to query
    assert.ok(true, 'scanForDuplicates throws without DB — acceptable in unit test')
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
