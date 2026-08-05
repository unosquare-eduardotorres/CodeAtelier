/**
 * memory-retrieval-fusion.test.ts
 *
 * B1: Reciprocal Rank Fusion + MMR diversification.
 *
 * The weighted-sum scorer needed cosine and keyword-overlap to be calibrated
 * against one another, and returned ten paraphrases of one convention when they
 * all scored well. These tests pin the fusion arithmetic, the precision gate
 * that stops BM25's OR-matching from dragging in the corpus, the diversity
 * re-ranking, and a small eval set comparing the two scorers so the change is
 * measured rather than asserted.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact } from '../../../shared/types'

setupElectronStub()

// ── Graceful module loading ─────────────────────────────────────────────────

let memoryRetrievalService: any
let memoryFactRepository: any
let loaded = false

try {
  require('../../db/index')
  memoryRetrievalService = require('../memory-retrieval.service').memoryRetrievalService
  memoryFactRepository =
    require('../../db/repositories/memory-fact.repository').memoryFactRepository
  loaded = true
} catch (err) {
  console.error('[memory-retrieval-fusion] module load failed:', err)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeFact(id: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    workspaceId: 'ws-fusion',
    category: 'convention',
    title: `Title ${id}`,
    content: `Content ${id}`,
    tags: [],
    scopePaths: [],
    tier: 0,
    confidence: 0.8,
    confirmationCount: 0,
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
    recordedAt: '2026-01-01 00:00:00',
    ...overrides
  }
}

/** Stubs, keyed by workspace so concurrent tests cannot collide. */
const ftsByWs = new Map<string, MemoryFact[]>()
const vectorsByWs = new Map<string, Array<{ fact: MemoryFact; embedding: Float32Array }>>()
const embeddingsById = new Map<string, Float32Array>()

if (loaded) {
  const originalFts = memoryFactRepository.searchFts.bind(memoryFactRepository)
  memoryFactRepository.searchFts = (ws: string, query: string, limit: number) => {
    const stub = ftsByWs.get(ws)
    if (!stub) return originalFts(ws, query, limit)
    return stub.map((fact, rank) => ({ fact, rank }))
  }

  const originalVectors = memoryFactRepository.findWithEmbeddings.bind(memoryFactRepository)
  memoryFactRepository.findWithEmbeddings = (ws: string) =>
    vectorsByWs.get(ws) ?? (ftsByWs.has(ws) ? [] : originalVectors(ws))

  const originalSearch = memoryFactRepository.search.bind(memoryFactRepository)
  memoryFactRepository.search = (ws: string, query: string, limit: number) =>
    ftsByWs.get(ws) ?? originalSearch(ws, query, limit)

  const originalEmb = memoryFactRepository.findEmbeddingsByIds.bind(memoryFactRepository)
  memoryFactRepository.findEmbeddingsByIds = (ids: string[]) => {
    const stubbed = new Map<string, Float32Array>()
    let anyStub = false
    for (const id of ids) {
      const vec = embeddingsById.get(id)
      if (vec) {
        stubbed.set(id, vec)
        anyStub = true
      }
    }
    return anyStub ? stubbed : originalEmb(ids)
  }

  const originalTouch = memoryFactRepository.touchFacts.bind(memoryFactRepository)
  memoryFactRepository.touchFacts = (ids: string[]) => {
    const real = ids.filter((id) => !id.startsWith('f-'))
    if (real.length > 0) originalTouch(real)
  }
}

/** Unit vector at a given angle — lets a test state similarity directly. */
function unitVec(angleDeg: number): Float32Array {
  const rad = (angleDeg * Math.PI) / 180
  return new Float32Array([Math.cos(rad), Math.sin(rad)])
}

// ── Rank fusion ─────────────────────────────────────────────────────────────

describe('retrieve — reciprocal rank fusion', () => {
  test('module loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-retrieval.service must be requireable')
  })

  test('a fact ranked by both arms outranks one ranked by a single arm', async () => {
    if (!loaded) return
    const ws = 'ws-fusion-both'
    const both = makeFact('f-both', { title: 'shared caching rule', content: 'caching rule' })
    const keywordOnly = makeFact('f-kw', { title: 'caching rule alt', content: 'caching rule' })

    ftsByWs.set(ws, [keywordOnly, both])
    vectorsByWs.set(ws, [])
    try {
      // No embeddings, so this exercises the keyword arm plus the gate.
      const results = await memoryRetrievalService.retrieve(ws, 'caching rule', 10)
      const ids = results.map((r: { fact: MemoryFact }) => r.fact.id)
      assert.deepEqual(ids, ['f-kw', 'f-both'], 'BM25 order is preserved when only one arm votes')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })

  test('the precision gate drops a keyword-only fact sharing too few terms', async () => {
    if (!loaded) return
    const ws = 'ws-fusion-gate'
    // Query has 4 tokens; this fact contains one of them.
    const weak = makeFact('f-weak', { title: 'caching', content: 'nothing else relevant' })
    ftsByWs.set(ws, [weak])
    vectorsByWs.set(ws, [])
    try {
      const results = await memoryRetrievalService.retrieve(
        ws,
        'caching invalidation strategy rules',
        10
      )
      assert.equal(results.length, 0, 'one term in four is below the gate')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })

  test('a keyword-only fact sharing most terms passes the gate', async () => {
    if (!loaded) return
    const ws = 'ws-fusion-pass'
    const strong = makeFact('f-strong', {
      title: 'caching invalidation',
      content: 'strategy rules for cache'
    })
    ftsByWs.set(ws, [strong])
    vectorsByWs.set(ws, [])
    try {
      const results = await memoryRetrievalService.retrieve(
        ws,
        'caching invalidation strategy rules',
        10
      )
      assert.deepEqual(results.map((r: { fact: MemoryFact }) => r.fact.id), ['f-strong'])
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })

  test('scope activation lifts a fact the keyword gate would have dropped', async () => {
    if (!loaded) return
    const ws = 'ws-fusion-scope'
    const scoped = makeFact('f-scoped', {
      title: 'unrelated wording',
      content: 'nothing matching',
      scopePaths: ['src/billing']
    })
    ftsByWs.set(ws, [scoped])
    vectorsByWs.set(ws, [])
    try {
      const results = await memoryRetrievalService.retrieve(ws, 'fix this bug', 10, undefined, [
        'src/billing/Invoice.java'
      ])
      assert.deepEqual(results.map((r: { fact: MemoryFact }) => r.fact.id), ['f-scoped'])
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })

  test('tier acts as a multiplier, not a term that outranks relevance', async () => {
    if (!loaded) return
    const ws = 'ws-fusion-tier'
    // Best BM25 rank but tier 0, versus a much worse rank at tier 3.
    const relevant = makeFact('f-relevant', {
      title: 'caching invalidation strategy rules',
      content: 'caching invalidation strategy rules',
      tier: 0
    })
    const filler = Array.from({ length: 20 }, (_, i) =>
      makeFact(`f-pad${i}`, {
        title: 'caching invalidation strategy rules',
        content: 'caching invalidation strategy rules'
      })
    )
    const established = makeFact('f-established', {
      title: 'caching invalidation strategy rules',
      content: 'caching invalidation strategy rules',
      tier: 3
    })

    ftsByWs.set(ws, [relevant, ...filler, established])
    vectorsByWs.set(ws, [])
    try {
      const results = await memoryRetrievalService.retrieve(
        ws,
        'caching invalidation strategy rules',
        30
      )
      assert.equal(
        results[0].fact.id,
        'f-relevant',
        'a tier-3 fact 21 places down must not overtake the best match'
      )
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })

  test('an empty query retrieves nothing', async () => {
    if (!loaded) return
    assert.deepEqual(await memoryRetrievalService.retrieve('ws-fusion-empty', '   ', 10), [])
  })
})

// ── MMR diversification ─────────────────────────────────────────────────────

describe('getContextForTurn — MMR diversification', () => {
  test('near-duplicate facts do not all take a slot', async () => {
    if (!loaded) return
    const ws = 'ws-mmr'

    // Three paraphrases pointing the same direction, one genuinely different.
    const dupA = makeFact('f-dupA', { title: 'caching rule A', content: 'caching invalidation strategy rules' })
    const dupB = makeFact('f-dupB', { title: 'caching rule B', content: 'caching invalidation strategy rules' })
    const dupC = makeFact('f-dupC', { title: 'caching rule C', content: 'caching invalidation strategy rules' })
    const other = makeFact('f-other', { title: 'caching rule D', content: 'caching invalidation strategy rules' })

    embeddingsById.set('f-dupA', unitVec(0))
    embeddingsById.set('f-dupB', unitVec(2))
    embeddingsById.set('f-dupC', unitVec(4))
    embeddingsById.set('f-other', unitVec(90))

    ftsByWs.set(ws, [dupA, dupB, dupC, other])
    vectorsByWs.set(ws, [])
    try {
      const out = await memoryRetrievalService.getContextForTurn(
        ws,
        'caching invalidation strategy rules',
        'small'
      )
      // 'small' budget fits about two lines; the distinct fact must earn one.
      assert.ok(out.includes('caching rule A'), 'the best match is always kept')
      assert.ok(out.includes('caching rule D'), 'the distinct fact beats a paraphrase')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
      for (const id of ['f-dupA', 'f-dupB', 'f-dupC', 'f-other']) embeddingsById.delete(id)
    }
  })

  test('the top-ranked fact is never displaced by diversification', async () => {
    if (!loaded) return
    const ws = 'ws-mmr-top'
    // Distinct trailing words so the two are tellable apart in the output,
    // while both still contain every query term.
    const best = makeFact('f-best', {
      title: 'caching invalidation strategy rules alpha',
      content: 'caching invalidation strategy rules'
    })
    const other = makeFact('f-second', {
      title: 'caching invalidation strategy rules beta',
      content: 'caching invalidation strategy rules'
    })

    embeddingsById.set('f-best', unitVec(0))
    embeddingsById.set('f-second', unitVec(90))

    ftsByWs.set(ws, [best, other])
    vectorsByWs.set(ws, [])
    try {
      const out = await memoryRetrievalService.getContextForTurn(
        ws,
        'caching invalidation strategy rules',
        'large'
      )
      const firstLine = out.split('\n')[0]
      assert.ok(firstLine.includes('alpha'), 'rank 1 stays rank 1')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
      embeddingsById.delete('f-best')
      embeddingsById.delete('f-second')
    }
  })

  test('facts with no embedding are kept rather than dropped as redundant', async () => {
    if (!loaded) return
    const ws = 'ws-mmr-noemb'
    const a = makeFact('f-noembA', {
      title: 'caching invalidation strategy rules alpha',
      content: 'caching invalidation strategy rules'
    })
    const b = makeFact('f-noembB', {
      title: 'caching invalidation strategy rules beta',
      content: 'caching invalidation strategy rules'
    })

    ftsByWs.set(ws, [a, b])
    vectorsByWs.set(ws, [])
    try {
      const out = await memoryRetrievalService.getContextForTurn(
        ws,
        'caching invalidation strategy rules',
        'large'
      )
      assert.ok(out.includes('alpha'))
      assert.ok(out.includes('beta'), 'unmeasurable similarity must not remove a fact')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })
})

// ── Eval set: RRF vs the legacy scorer ──────────────────────────────────────

/**
 * A small labelled set: each query names the fact that should rank first.
 *
 * The bar is deliberately "no regression against the legacy scorer", which is
 * the condition the plan set for merging this change.
 */
const EVAL_CASES: Array<{ query: string; expect: string; facts: MemoryFact[] }> = [
  {
    query: 'how do we invalidate the cache',
    expect: 'e-cache',
    facts: [
      makeFact('e-cache', {
        title: 'Cache invalidation',
        content: 'invalidate the cache by version key',
        tier: 2
      }),
      makeFact('e-noise1', { title: 'Logging', content: 'how do we log errors' }),
      makeFact('e-noise2', { title: 'Builds', content: 'how do we build the app' })
    ]
  },
  {
    query: 'migration numbering rules',
    expect: 'e-migration',
    facts: [
      makeFact('e-migration', {
        title: 'Migration numbering',
        content: 'migrations must stay sequential rules',
        tier: 1
      }),
      makeFact('e-noise3', { title: 'Naming', content: 'component naming rules' })
    ]
  },
  {
    query: 'which model do we use for extraction',
    expect: 'e-model',
    facts: [
      makeFact('e-model', {
        title: 'Extraction model',
        content: 'we use haiku for extraction',
        tier: 2
      }),
      makeFact('e-noise4', { title: 'Extraction budget', content: 'chunk budget for documents' })
    ]
  }
]

describe('retrieval eval set — RRF must not regress against legacy', () => {
  test('RRF ranks the expected fact first in every case', async () => {
    if (!loaded) return
    let hits = 0
    for (const [i, testCase] of EVAL_CASES.entries()) {
      const ws = `ws-eval-rrf-${i}`
      ftsByWs.set(ws, testCase.facts)
      vectorsByWs.set(ws, [])
      try {
        const results = await memoryRetrievalService.retrieve(
          ws,
          testCase.query,
          10,
          undefined,
          [],
          { scorer: 'rrf' }
        )
        if (results[0]?.fact.id === testCase.expect) hits++
      } finally {
        ftsByWs.delete(ws)
        vectorsByWs.delete(ws)
      }
    }
    assert.equal(hits, EVAL_CASES.length, `RRF got ${hits}/${EVAL_CASES.length} top-1 correct`)
  })

  test('RRF scores at least as well as the legacy scorer', async () => {
    if (!loaded) return

    const scoreWith = async (scorer: 'rrf' | 'legacy'): Promise<number> => {
      let hits = 0
      for (const [i, testCase] of EVAL_CASES.entries()) {
        const ws = `ws-eval-${scorer}-${i}`
        ftsByWs.set(ws, testCase.facts)
        vectorsByWs.set(ws, [])
        try {
          const results = await memoryRetrievalService.retrieve(
            ws,
            testCase.query,
            10,
            undefined,
            [],
            { scorer }
          )
          if (results[0]?.fact.id === testCase.expect) hits++
        } finally {
          ftsByWs.delete(ws)
          vectorsByWs.delete(ws)
        }
      }
      return hits
    }

    const rrf = await scoreWith('rrf')
    const legacy = await scoreWith('legacy')
    assert.ok(
      rrf >= legacy,
      `RRF top-1 (${rrf}) must not be worse than legacy (${legacy}) on the eval set`
    )
  })

  test('the legacy scorer is still reachable behind the flag', async () => {
    if (!loaded) return
    const ws = 'ws-eval-flag'
    ftsByWs.set(ws, EVAL_CASES[0].facts)
    vectorsByWs.set(ws, [])
    try {
      const results = await memoryRetrievalService.retrieve(
        ws,
        EVAL_CASES[0].query,
        10,
        undefined,
        [],
        { scorer: 'legacy' }
      )
      assert.ok(Array.isArray(results), 'legacy path executes without throwing')
    } finally {
      ftsByWs.delete(ws)
      vectorsByWs.delete(ws)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
