/**
 * Phase 26 Wave 3 — memory-engine.service.ts pipeline method bodies.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. Every test targets a deterministic, hermetic branch:
 * embeddings are never ready in this test environment (no local LLM configured),
 * so the dedup/classify branches that would spawn a real process are never
 * reached — writeFact falls straight through to the plain-insert path, and
 * backfillAllPendingEmbeddings short-circuits on `!isReady`. Both are exercised
 * as real assertions below, with no LLM process spawned (FR-023).
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../memory-engine.service')
const { memoryEngineService, CAPTURE_CAPS } = mod
const { MAX_FACTS_PER_SESSION } = CAPTURE_CAPS
const memoryRepo = getMockRepo('memoryFact')

describe('MemoryEngine pipeline (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // ─── confirmFactWithPromotion ────────────────────────────────────────────
  test('confirmFactWithPromotion throws when the fact does not exist', () => {
    memoryRepo.findById.mockReturnValue(null)
    assert.throws(
      () => memoryEngineService.confirmFactWithPromotion('missing-id'),
      /MemoryFact not found: missing-id/
    )
    assert.equal(memoryRepo.addConfirmation.callCount, 0)
  })

  test('confirmFactWithPromotion caps a volatile fact at tier 0 and records full-weight evidence', () => {
    memoryRepo.findById.mockReturnValue({ id: 'f-1', volatile: true, tier: 2, confidence: 0.9 })
    memoryRepo.confirmFact.mockImplementation((id: string, tier: number) => ({ id, tier }))

    const result = memoryEngineService.confirmFactWithPromotion('f-1', 'human')

    assert.equal(memoryRepo.addConfirmation.callCount, 1)
    assert.deepEqual(memoryRepo.addConfirmation.lastCall, ['f-1', 'human', 1.0])
    // Volatile facts never promote — computePromotionTier short-circuits to 0.
    assert.deepEqual(memoryRepo.confirmFact.lastCall, ['f-1', 0])
    assert.equal(result.tier, 0)
  })

  test('confirmFactWithPromotion records zero-weight evidence for auto_dedup confirmations', () => {
    memoryRepo.findById.mockReturnValue({ id: 'f-2', volatile: false, tier: 0, confidence: 0.5 })
    memoryRepo.getConfirmations.mockReturnValue([])
    memoryRepo.confirmFact.mockImplementation((id: string, tier: number) => ({ id, tier }))

    memoryEngineService.confirmFactWithPromotion('f-2', 'auto_dedup')

    assert.deepEqual(memoryRepo.addConfirmation.lastCall, ['f-2', 'auto_dedup', 0.0])
    // getConfirmations is consulted to compute the post-confirmation tier for non-volatile facts.
    assert.equal(memoryRepo.getConfirmations.callCount, 1)
  })

  // ─── writeFact (no embedding provider ready → plain-insert path) ────────
  // NOTE: both phases share this describe block's single memoryRepo.createFact
  // spy. The harness runs sibling tests' beforeEach ticks eagerly (see
  // test-harness.ts test()), so two separate `test()` blocks that both await
  // writeFact() can interleave their calls onto the same spy. Kept as one
  // test so the call sequence — and therefore the assertions below — is
  // deterministic.
  test('writeFact bypasses the capture cap for manual sourceType, then enforces the per-session cap', async () => {
    memoryRepo.createFact.mockImplementation((p: any) => ({ id: `f-${p.title}`, tier: 0, volatile: false }))

    const manualResult = await memoryEngineService.writeFact({
      workspaceId: null,
      category: 'decision',
      title: 'Use PostgreSQL',
      content: 'We decided to use PostgreSQL instead of SQLite.',
      sourceType: 'manual'
    })
    assert.equal(manualResult.id, 'f-Use PostgreSQL')
    assert.equal(memoryRepo.createFact.callCount, 1)
    assert.equal(memoryRepo.createFact.lastCall[0].title, 'Use PostgreSQL')

    memoryRepo.findByWorkspace.mockReturnValue([]) // no title-fallback dedup match
    const sourceRef = 'sess-cap-test'
    let created = 0
    for (let i = 0; i < MAX_FACTS_PER_SESSION + 2; i++) {
      const result = await memoryEngineService.writeFact({
        workspaceId: 'ws-1',
        category: 'gotcha',
        title: `Fact number ${i}`,
        content: `Content ${i}`,
        sourceType: 'session',
        sourceRef
      })
      if (result) created++
    }

    // Only MAX_FACTS_PER_SESSION session-sourced writes are allowed through the
    // cap; the rest return null without ever reaching createFact. The single
    // preceding manual-sourceType write always bypasses the cap.
    assert.equal(created, MAX_FACTS_PER_SESSION)
    assert.equal(memoryRepo.createFact.callCount, 1 + MAX_FACTS_PER_SESSION)
  })

  // ─── backfillAllPendingEmbeddings ────────────────────────────────────────
  test('backfillAllPendingEmbeddings is a no-op when the embedding provider is not ready', async () => {
    // No local embedding model is loaded in the test environment — isReady is false,
    // so this must short-circuit to 0 without ever touching findPendingEmbeddings.
    const processed = await memoryEngineService.backfillAllPendingEmbeddings()
    assert.equal(processed, 0)
    assert.equal(memoryRepo.findPendingEmbeddings.callCount, 0)
  })
})
