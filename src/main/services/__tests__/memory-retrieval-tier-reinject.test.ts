/**
 * memory-retrieval-tier-reinject.test.ts
 *
 * `injectedFactIds` grows monotonically for the life of a session, so a fact
 * injected once was never injected again — even after compaction evicted the
 * turn that carried it. Knowledge/Wisdom facts (tier >= 2) are now exempt from
 * that suppression. These tests pin that behaviour.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact, MemoryRetrievalResult } from '../../../shared/types'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let memoryRetrievalService: any
let memoryFactRepository: any
let loaded = false

try {
  // db/index must be loaded first: base-repository imports it, so requiring a
  // repository cold trips a TDZ cycle (`Cannot access 'BaseRepository'`).
  require('../../db/index')
  memoryRetrievalService = require('../memory-retrieval.service').memoryRetrievalService
  memoryFactRepository =
    require('../../db/repositories/memory-fact.repository').memoryFactRepository
  loaded = true
} catch (err) {
  console.error('[memory-retrieval-tier-reinject] module load failed:', err)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeFact(id: string, tier: number): MemoryFact {
  return {
    id,
    workspaceId: 'ws-1',
    category: 'convention',
    title: `Fact ${id}`,
    content: `Content for ${id}`,
    tags: [],
    scopePaths: [],
    tier: tier as MemoryFact['tier'],
    confidence: 0.9,
    confirmationCount: 3,
    lastConfirmedAt: null,
    status: 'active',
    supersededBy: null,
    mergedInto: null,
    volatile: false,
    sourceType: 'bootstrap',
    sourceRef: null,
    embeddingPending: false,
    lastAccessedAt: null,
    createdAt: '2026-01-01 00:00:00',
    updatedAt: '2026-01-01 00:00:00',
    validFrom: '2026-01-01 00:00:00',
    validTo: null,
    observedAt: '2026-01-01 00:00:00',
    recordedAt: '2026-01-01 00:00:00'
  }
}

function makeResult(id: string, tier: number): MemoryRetrievalResult {
  return { fact: makeFact(id, tier), score: 0.9 } as MemoryRetrievalResult
}

/**
 * The harness runs async tests concurrently, so the stubs are installed once
 * and dispatch on the prompt text rather than being swapped per test.
 */
const resultsByPrompt = new Map<string, MemoryRetrievalResult[]>()

/** Synthetic fact ids that must never reach the real DB. */
const SYNTHETIC_IDS = new Set(['low-1', 'low-2', 'high-1', 'high-2', 'mixed-low', 'mixed-high'])

if (loaded) {
  memoryRetrievalService.retrieve = async (
    _ws: string,
    prompt: string
  ): Promise<MemoryRetrievalResult[]> => resultsByPrompt.get(prompt) ?? []

  // Filter out our synthetic ids but keep real touches working — other test
  // files in the shared runner rely on touchFacts hitting the DB.
  const originalTouch = memoryFactRepository.touchFacts.bind(memoryFactRepository)
  memoryFactRepository.touchFacts = (ids: string[]) => {
    const real = ids.filter((id) => !SYNTHETIC_IDS.has(id))
    if (real.length > 0) originalTouch(real)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getContextForTurn — session dedupe', () => {
  test('modules loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-retrieval.service must be requireable')
    assert.equal(typeof memoryRetrievalService?.getContextForTurn, 'function')
  })

  test('tier 0/1 facts are suppressed after their first injection', async () => {
    if (!loaded) return
    const prompt = 'low-tier-prompt'
    resultsByPrompt.set(prompt, [makeResult('low-1', 0), makeResult('low-2', 1)])
    try {
      const injected = new Set<string>()
      const first = await memoryRetrievalService.getContextForTurn(
        'ws-1',
        prompt,
        'medium',
        injected
      )
      assert.ok(first.includes('low-1'), 'first turn injects the fact')
      assert.equal(injected.size, 2)

      const second = await memoryRetrievalService.getContextForTurn(
        'ws-1',
        prompt,
        'medium',
        injected
      )
      assert.equal(second, '', 'tier 0/1 facts are not repeated')
    } finally {
      resultsByPrompt.delete(prompt)
    }
  })

  test('tier 2/3 facts are re-injected even after being seen', async () => {
    if (!loaded) return
    const prompt = 'high-tier-prompt'
    resultsByPrompt.set(prompt, [makeResult('high-1', 2), makeResult('high-2', 3)])
    try {
      const injected = new Set<string>(['high-1', 'high-2'])
      const out = await memoryRetrievalService.getContextForTurn('ws-1', prompt, 'medium', injected)
      assert.ok(out.includes('high-1'), 'Knowledge (tier 2) facts bypass suppression')
      assert.ok(out.includes('high-2'), 'Wisdom (tier 3) facts bypass suppression')
    } finally {
      resultsByPrompt.delete(prompt)
    }
  })

  test('mixed set drops the seen low-tier fact but keeps the high-tier one', async () => {
    if (!loaded) return
    const prompt = 'mixed-tier-prompt'
    resultsByPrompt.set(prompt, [makeResult('mixed-low', 1), makeResult('mixed-high', 2)])
    try {
      const injected = new Set<string>(['mixed-low', 'mixed-high'])
      const out = await memoryRetrievalService.getContextForTurn('ws-1', prompt, 'medium', injected)
      assert.ok(!out.includes('mixed-low'), 'seen tier-1 fact stays suppressed')
      assert.ok(out.includes('mixed-high'), 'seen tier-2 fact is repeated')
    } finally {
      resultsByPrompt.delete(prompt)
    }
  })
})

// summaryAsync calls process.exit — unguarded it kills the whole suite when this
// file is imported by a runner, taking every later test file with it.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
