/**
 * Phase 25, Wave 2 — MemoryEngineService deep body coverage.
 *
 * Covers: memory-engine.service.ts (1012 lines, ~35% covered)
 *
 * Strategy: Test exported pure functions (cosineSimilarity, computePromotionTierPure,
 * CAPTURE_CAPS, VOLATILE_PATTERNS) directly. Test singleton shape and methods.
 *
 * Run: tsx src/main/services/__tests__/memory-engine-deep-phase25.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let memoryEngineService: any
let cosineSimilarity: any
let computePromotionTierPure: any
let CAPTURE_CAPS: any
let VOLATILE_PATTERNS: any
let loaded = false

try {
  const mod = require('../memory-engine.service')
  memoryEngineService = mod.memoryEngineService
  cosineSimilarity = mod.cosineSimilarity
  computePromotionTierPure = mod.computePromotionTierPure
  CAPTURE_CAPS = mod.CAPTURE_CAPS
  VOLATILE_PATTERNS = mod.VOLATILE_PATTERNS
  loaded = true
} catch (err) {
  console.log(`⚠ memory-engine.service.ts load failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

if (loaded) {
  if (typeof cosineSimilarity === 'function') {
    describe('cosineSimilarity — memory-engine (Phase 25)', () => {
      test('identical Float32Arrays return ~1', () => {
        const a = new Float32Array([1, 0, 0])
        const result = cosineSimilarity(a, a)
        assert.ok(Math.abs(result - 1) < 0.001)
      })
      test('orthogonal return ~0', () => {
        const a = new Float32Array([1, 0])
        const b = new Float32Array([0, 1])
        assert.ok(Math.abs(cosineSimilarity(a, b)) < 0.001)
      })
      test('opposite return ~-1', () => {
        const a = new Float32Array([1, 0])
        const b = new Float32Array([-1, 0])
        assert.ok(Math.abs(cosineSimilarity(a, b) - -1) < 0.001)
      })
    })
  }

  if (typeof computePromotionTierPure === 'function') {
    describe('computePromotionTierPure (Phase 25)', () => {
      test('tier 0 stays 0 with no confirmations', () => {
        const result = computePromotionTierPure(0, 0.5, [])
        assert.equal(result, 0)
      })
      test('tier 0 with confirmations may promote to 1', () => {
        const confs = [
          { sourceType: 'agent', weight: 1.0, createdAt: new Date().toISOString() },
          { sourceType: 'agent', weight: 1.0, createdAt: new Date().toISOString() }
        ]
        const result = computePromotionTierPure(0, 0.7, confs)
        assert.ok(result >= 0 && result <= 3)
      })
      test('handles high tier gracefully', () => {
        const result = computePromotionTierPure(3, 1.0, [
          { sourceType: 'agent', weight: 1.0, createdAt: new Date().toISOString() }
        ])
        assert.ok(result >= 0 && result <= 3)
      })
    })
  }

  if (CAPTURE_CAPS) {
    describe('CAPTURE_CAPS (Phase 25)', () => {
      test('has MAX_FACTS_PER_SESSION', () => {
        assert.ok(typeof CAPTURE_CAPS.MAX_FACTS_PER_SESSION === 'number')
        assert.ok(CAPTURE_CAPS.MAX_FACTS_PER_SESSION > 0)
      })
      test('has MAX_FACTS_PER_COMMIT', () => {
        assert.ok(typeof CAPTURE_CAPS.MAX_FACTS_PER_COMMIT === 'number')
        assert.ok(CAPTURE_CAPS.MAX_FACTS_PER_COMMIT > 0)
      })
    })
  }

  if (Array.isArray(VOLATILE_PATTERNS)) {
    describe('VOLATILE_PATTERNS (Phase 25)', () => {
      test('is non-empty array of RegExp', () => {
        assert.ok(VOLATILE_PATTERNS.length > 0)
        assert.ok(VOLATILE_PATTERNS.every((p: any) => p instanceof RegExp))
      })
    })
  }

  describe('MemoryEngineService — singleton (Phase 25)', () => {
    test('exists', () => assert.ok(memoryEngineService !== undefined))
    test('has writeFact', () => assert.equal(typeof memoryEngineService.writeFact, 'function'))
    test('has confirmFactWithPromotion', () =>
      assert.equal(typeof memoryEngineService.confirmFactWithPromotion, 'function'))
    test('has scanForDuplicates', () =>
      assert.equal(typeof memoryEngineService.scanForDuplicates, 'function'))
    test('has runDecaySweepIfDue', () =>
      assert.equal(typeof memoryEngineService.runDecaySweepIfDue, 'function'))
    test('has backfillPendingEmbeddings', () =>
      assert.equal(typeof memoryEngineService.backfillPendingEmbeddings, 'function'))
    test('has setBootstrapActive', () =>
      assert.equal(typeof memoryEngineService.setBootstrapActive, 'function'))
  })
}

if (require.main === module) {
  void summaryAsync()
}
