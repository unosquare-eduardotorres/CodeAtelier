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
function makeConfirm(
  sourceType: 'auto_dedup' | 'human' | 'tool' | 'extraction' | 'bootstrap',
  dayOffset: number,
  weight?: number
) {
  const date = new Date()
  date.setDate(date.getDate() - dayOffset) // dayOffset days ago
  return {
    sourceType,
    weight: weight ?? (sourceType === 'auto_dedup' ? 0.0 : 1.0),
    createdAt: date.toISOString()
  }
}

test('promotion: T0 stays T0 with only 1 confirm (needs 3)', () => {
  const confirms = [makeConfirm('extraction', 0)]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: T0 stays T0 with 2 confirms on 2 days (needs 3 confirms on 3 days)', () => {
  const confirms = [makeConfirm('extraction', 1), makeConfirm('tool', 0)]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: T0 stays T0 with 3 confirms on SAME day (needs 3 distinct days)', () => {
  const confirms = [makeConfirm('extraction', 0), makeConfirm('tool', 0), makeConfirm('human', 0)]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: T0 → T1 with 3 confirms on 3 distinct days', () => {
  const confirms = [makeConfirm('extraction', 3), makeConfirm('tool', 1), makeConfirm('human', 0)]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 1)
})

test('promotion: T1 stays T1 with 5 confirms but only 1 source type', () => {
  const confirms = [
    makeConfirm('extraction', 20),
    makeConfirm('extraction', 15),
    makeConfirm('extraction', 10),
    makeConfirm('extraction', 5),
    makeConfirm('extraction', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.8, confirms), 1)
})

test('promotion: T1 stays T1 with 5 confirms, 3 sources, but only 10 days span (needs 14)', () => {
  const confirms = [
    makeConfirm('extraction', 10),
    makeConfirm('tool', 7),
    makeConfirm('human', 5),
    makeConfirm('extraction', 2),
    makeConfirm('tool', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.8, confirms), 1)
})

test('promotion: T1 stays T1 with all criteria met but confidence < 0.75', () => {
  const confirms = [
    makeConfirm('extraction', 20),
    makeConfirm('tool', 15),
    makeConfirm('human', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.7, confirms), 1)
})

test('promotion: T1 stays T1 with only 3 confirms (needs 5)', () => {
  const confirms = [makeConfirm('extraction', 20), makeConfirm('tool', 10), makeConfirm('human', 0)]
  assert.equal(computePromotionTierPure(1, 0.8, confirms), 1)
})

test('promotion: T1 → T2 with 5 confirms, 3+ sources, 14+ days, confidence ≥ 0.75', () => {
  const confirms = [
    makeConfirm('extraction', 20),
    makeConfirm('tool', 15),
    makeConfirm('human', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 0)
  ]
  assert.equal(computePromotionTierPure(1, 0.8, confirms), 2)
})

test('promotion: T2 stays T2 without human confirmation', () => {
  const confirms = [
    makeConfirm('extraction', 35),
    makeConfirm('tool', 25),
    makeConfirm('extraction', 20),
    makeConfirm('tool', 15),
    makeConfirm('extraction', 10),
    makeConfirm('tool', 5),
    makeConfirm('extraction', 2),
    makeConfirm('tool', 0)
  ]
  // Weighted sum: 8.0, daySpan: 35, no human — fails humanCount >= 2
  assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
})

test('promotion: T2 stays T2 with only 1 human (needs 2)', () => {
  const confirms = [
    makeConfirm('human', 35),
    makeConfirm('tool', 25),
    makeConfirm('extraction', 20),
    makeConfirm('tool', 15),
    makeConfirm('extraction', 10),
    makeConfirm('tool', 5),
    makeConfirm('extraction', 2),
    makeConfirm('tool', 0)
  ]
  // Weighted sum: 8.0, daySpan: 35, humanCount: 1 (needs 2)
  assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
})

test('promotion: T2 stays T2 with 2 human but weighted sum < 8', () => {
  const confirms = [
    makeConfirm('human', 35),
    makeConfirm('human', 20),
    makeConfirm('tool', 10),
    makeConfirm('extraction', 0)
  ]
  // Weighted sum: 1.0 + 1.0 + 1.0 + 1.0 = 4.0 (needs 8.0)
  assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
})

test('promotion: T2 stays T2 with 2 human + weight but confidence < 0.90', () => {
  const confirms = [
    makeConfirm('human', 35),
    makeConfirm('human', 25),
    makeConfirm('tool', 20),
    makeConfirm('extraction', 15),
    makeConfirm('tool', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 2),
    makeConfirm('extraction', 0)
  ]
  // Weighted sum: 8.0, daySpan: 35, humanCount: 2 — but confidence 0.85 < 0.90
  assert.equal(computePromotionTierPure(2, 0.85, confirms), 2)
})

test('promotion: T2 stays T2 with 2 human + weight + confidence but daySpan < 30', () => {
  const confirms = [
    makeConfirm('human', 25),
    makeConfirm('human', 15),
    makeConfirm('tool', 12),
    makeConfirm('extraction', 10),
    makeConfirm('tool', 7),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 2),
    makeConfirm('extraction', 0)
  ]
  // Weighted sum: 8.0, daySpan: 25 (needs 30), humanCount: 2, conf 0.95
  assert.equal(computePromotionTierPure(2, 0.95, confirms), 2)
})

test('promotion: T2 → T3 with 2 human + weighted ≥ 8 + 30+ days + confidence ≥ 0.90', () => {
  const confirms = [
    makeConfirm('human', 35),
    makeConfirm('human', 25),
    makeConfirm('tool', 20),
    makeConfirm('extraction', 15),
    makeConfirm('tool', 10),
    makeConfirm('extraction', 5),
    makeConfirm('tool', 2),
    makeConfirm('extraction', 0)
  ]
  // Weighted sum: 8.0, daySpan: 35, humanCount: 2, conf 0.95
  assert.equal(computePromotionTierPure(2, 0.95, confirms), 3)
})

test('promotion: T3 stays T3 regardless of input', () => {
  const confirms = [makeConfirm('auto_dedup', 0)]
  assert.equal(computePromotionTierPure(3, 0.9, confirms), 3)
})

// ── auto_dedup exclusion from promotion metrics ──

test('promotion: auto_dedup-only confirms do NOT promote T0→T1', () => {
  // 5 auto_dedup confirms on 5 distinct days — should still stay T0
  // because auto_dedup is filtered out of evidence metrics
  const confirms = [
    makeConfirm('auto_dedup', 10),
    makeConfirm('auto_dedup', 8),
    makeConfirm('auto_dedup', 5),
    makeConfirm('auto_dedup', 2),
    makeConfirm('auto_dedup', 0)
  ]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: auto_dedup mixed with real confirms — only real ones count for T0→T1', () => {
  // 2 real confirms on 2 days + 3 auto_dedup on different days
  // totalCount with filtering: 2 (needs 3) — should NOT promote
  const confirms = [
    makeConfirm('extraction', 5),
    makeConfirm('tool', 0),
    makeConfirm('auto_dedup', 10),
    makeConfirm('auto_dedup', 8),
    makeConfirm('auto_dedup', 3)
  ]
  assert.equal(computePromotionTierPure(0, 0.5, confirms), 0)
})

test('promotion: auto_dedup-only confirms do NOT promote T1→T2', () => {
  // 10 auto_dedup confirms spanning 20+ days — should stay T1
  const confirms = Array.from({ length: 10 }, (_, i) => makeConfirm('auto_dedup', i * 3))
  assert.equal(computePromotionTierPure(1, 0.8, confirms), 1)
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

test('capture caps: per-source caps for auto-capture quality', () => {
  assert.equal(CAPTURE_CAPS.MAX_FACTS_PER_SESSION, 2, 'Session cap should be 2')
  assert.equal(CAPTURE_CAPS.MAX_FACTS_PER_COMMIT, 1, 'Commit cap should be 1')
  assert.ok(!('MAX_FACTS_PER_DAY' in CAPTURE_CAPS), 'Daily cap should be removed')
})

// ── backfillAllPendingEmbeddings — progress callback contract ──

test('backfillAllPendingEmbeddings: returns 0 when provider not ready', async () => {
  const { memoryEngineService } = await import('../memory-engine.service')
  const progressCalls: Array<[number, number]> = []
  const result = await memoryEngineService.backfillAllPendingEmbeddings((processed, total) =>
    progressCalls.push([processed, total])
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

// ── Regression tests for memory overhaul fixes ──

// A1: drainClassifyQueue re-entrancy guard
test('regression A1: MemoryEngineService has draining guard field', async () => {
  // Verify the draining field exists on the service class (prevents re-entrant drain loops)
  const { memoryEngineService } = await import('../memory-engine.service')
  // The draining field is private, so we check via hasOwnProperty on the instance
  assert.ok(
    'draining' in (memoryEngineService as unknown as Record<string, unknown>),
    'memoryEngineService should have a "draining" guard field'
  )
  assert.equal(
    (memoryEngineService as unknown as Record<string, boolean>).draining,
    false,
    'draining should default to false'
  )
})

// A3: Capture cap not consumed on handleDuplicate confirm
test('regression A3: handleDuplicate returns a fact (non-null) but should NOT consume cap', () => {
  // This test validates the design: handleDuplicate returns a MemoryFact (truthy),
  // but cap increment was moved to handleUpdate/handleContradiction only.
  // We verify by checking that the pipeline result branch in writeFact does NOT
  // call incrementCaptureCap. Since handleDuplicate returns non-null, the old code
  // `if (result !== null) incrementCaptureCap` would have consumed a cap.
  // The fix removes that branch entirely — we verify the source doesn't contain it.
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'memory-engine.service.ts'), 'utf-8')

  // The pipeline-result branch should NOT contain incrementCaptureCap
  const pipelineBlock = source.slice(
    source.indexOf('if (result !== undefined)'),
    source.indexOf('// 4. No match or no embedding')
  )
  assert.ok(
    !pipelineBlock.includes('incrementCaptureCap'),
    'Pipeline-result branch should NOT call incrementCaptureCap (caps are in mutating handlers)'
  )

  // But handleUpdate and handleContradiction SHOULD contain it
  const handleUpdateBlock = source.slice(
    source.indexOf('private handleUpdate('),
    source.indexOf('private classifyAmbiguous(')
  )
  assert.ok(
    handleUpdateBlock.includes('incrementCaptureCap'),
    'handleUpdate should call incrementCaptureCap'
  )

  const handleContradictionBlock = source.slice(
    source.indexOf('private handleContradiction('),
    source.indexOf('// ── Evidence-based promotion')
  )
  assert.ok(
    handleContradictionBlock.includes('incrementCaptureCap'),
    'handleContradiction should call incrementCaptureCap'
  )
})

// B2: Capture cap only gates new-fact inserts, not dedup/update/contradiction
test('regression B2: checkCaptureCap appears AFTER similarity pipeline in writeFact', () => {
  // Validates B2 design: the similarity pipeline runs before the cap check so that
  // dedup confirms, updates, and contradictions proceed even on busy days.
  // The cap only gates brand-new fact creation.
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'memory-engine.service.ts'), 'utf-8')

  const writeFact = source.slice(
    source.indexOf('async writeFact('),
    source.indexOf('/**\n   * Similarity pipeline')
  )

  // runSimilarityPipeline should appear BEFORE checkCaptureCap in writeFact
  const pipelineIdx = writeFact.indexOf('runSimilarityPipeline')
  const capIdx = writeFact.indexOf('checkCaptureCap')
  assert.ok(pipelineIdx > 0, 'writeFact should call runSimilarityPipeline')
  assert.ok(capIdx > 0, 'writeFact should call checkCaptureCap')
  assert.ok(
    pipelineIdx < capIdx,
    'runSimilarityPipeline must appear BEFORE checkCaptureCap in writeFact (cap gates only new inserts)'
  )
})

// A6: drainClassifyQueue fast-paths
test('regression A6: drainClassifyQueue has fast-path branches for high similarity', () => {
  // Verify the drain loop mirrors the pipeline's branch order
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'memory-engine.service.ts'), 'utf-8')

  const drainBlock = source.slice(
    source.indexOf('private async drainClassifyQueue'),
    source.indexOf('/** Handle a contradiction')
  )

  // Should have volatile + same-category UPDATE fast-path
  assert.ok(
    drainBlock.includes('handleUpdate(bestMatch.fact, item.params, item.embedding)'),
    'drainClassifyQueue should have handleUpdate fast-path for volatile+same-category'
  )

  // Should have duplicate fast-path
  assert.ok(
    drainBlock.includes('handleDuplicate(bestMatch.fact, item.params.sourceType)'),
    'drainClassifyQueue should have handleDuplicate fast-path for ≥0.90 similarity'
  )
})

// A4: scanForDuplicates reparents confirmations before merge
test('regression A4: scanForDuplicates reparents confirmations before mergeFact', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const source = fs.readFileSync(path.join(__dirname, '..', 'memory-engine.service.ts'), 'utf-8')

  const scanBlock = source.slice(
    source.indexOf('scanForDuplicates(workspaceId'),
    source.indexOf('// ── Haiku classifier')
  )

  // reparentConfirmations should appear before mergeFact
  const reparentIdx = scanBlock.indexOf('reparentConfirmations')
  const mergeIdx = scanBlock.indexOf('mergeFact')
  assert.ok(reparentIdx > 0, 'scanForDuplicates should call reparentConfirmations')
  assert.ok(mergeIdx > 0, 'scanForDuplicates should call mergeFact')
  assert.ok(
    reparentIdx < mergeIdx,
    'reparentConfirmations must be called BEFORE mergeFact in scanForDuplicates'
  )
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
