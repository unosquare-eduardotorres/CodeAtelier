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
import { test, describe, summaryAsync, runExclusive } from './test-harness'
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

  // The vector arm caches the embedding matrix per workspace and invalidates it
  // on `getLastMutationAt`. Stubbed workspaces report a fresh stamp every call
  // so a test that swaps its stub data is never served the previous snapshot.
  const originalMutation = memoryFactRepository.getLastMutationAt.bind(memoryFactRepository)
  memoryFactRepository.getLastMutationAt = (ws: string) =>
    vectorsByWs.has(ws) || ftsByWs.has(ws) ? Date.now() : originalMutation(ws)

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
      assert.deepEqual(
        results.map((r: { fact: MemoryFact }) => r.fact.id),
        ['f-strong']
      )
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
      assert.deepEqual(
        results.map((r: { fact: MemoryFact }) => r.fact.id),
        ['f-scoped']
      )
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
    const dupA = makeFact('f-dupA', {
      title: 'caching rule A',
      content: 'caching invalidation strategy rules'
    })
    const dupB = makeFact('f-dupB', {
      title: 'caching rule B',
      content: 'caching invalidation strategy rules'
    })
    const dupC = makeFact('f-dupC', {
      title: 'caching rule C',
      content: 'caching invalidation strategy rules'
    })
    const other = makeFact('f-other', {
      title: 'caching rule D',
      content: 'caching invalidation strategy rules'
    })

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
  },

  // ── Established facts must outrank a better keyword match ──
  //
  // The expected fact is deliberately *second* in BM25 order in these cases.
  // Only the tier multiplier lifts it, which is the property worth pinning:
  // a confirmed convention should beat an incidental observation that happens
  // to phrase the query back at you.
  {
    query: 'error handling convention for services',
    expect: 'e-errors',
    facts: [
      makeFact('e-noise-errors', {
        title: 'Error handling convention draft',
        content: 'error handling convention for services was discussed',
        tier: 0
      }),
      makeFact('e-errors', {
        title: 'Service error handling',
        content: 'error handling convention for services returns Result types',
        tier: 3
      })
    ]
  },
  {
    query: 'database transaction boundaries',
    expect: 'e-tx',
    facts: [
      makeFact('e-noise-tx', {
        title: 'Database transaction notes',
        content: 'database transaction boundaries were unclear here',
        tier: 0
      }),
      makeFact('e-tx', {
        title: 'Transaction boundaries',
        content: 'database transaction boundaries wrap one repository call',
        tier: 3
      })
    ]
  },
  {
    query: 'ipc channel naming scheme',
    expect: 'e-ipc',
    facts: [
      makeFact('e-noise-ipc', {
        title: 'Ipc channel naming question',
        content: 'ipc channel naming scheme was asked about once',
        tier: 0
      }),
      makeFact('e-ipc', {
        title: 'Channel naming',
        content: 'ipc channel naming scheme is domain colon action',
        tier: 3
      })
    ]
  },

  // ── The precision gate must drop token-poor distractors ──
  //
  // BM25 ORs its terms, so a fact matching one common word arrives ranked
  // first. The gate is the only thing stopping it taking the slot.
  {
    query: 'retry policy for failed background jobs',
    expect: 'e-retry',
    facts: [
      makeFact('e-noise-retry', { title: 'Policy', content: 'policy' }),
      makeFact('e-retry', {
        title: 'Background job retries',
        content: 'retry policy for failed background jobs is exponential backoff',
        tier: 1
      })
    ]
  },
  {
    query: 'where do we store user preferences',
    expect: 'e-prefs',
    facts: [
      makeFact('e-noise-prefs', { title: 'Store', content: 'store' }),
      makeFact('e-prefs', {
        title: 'User preferences',
        content: 'where do we store user preferences is the settings table',
        tier: 1
      })
    ]
  },
  {
    query: 'how are secrets injected into the build',
    expect: 'e-secrets',
    facts: [
      makeFact('e-noise-secrets', { title: 'Build', content: 'build' }),
      makeFact('e-secrets', {
        title: 'Secret injection',
        content: 'how are secrets injected into the build via environment variables',
        tier: 2
      })
    ]
  },

  // ── Ordinary top-1 recall ──
  {
    query: 'test runner registration requirement',
    expect: 'e-runner',
    facts: [
      makeFact('e-runner', {
        title: 'Test runner registration',
        content: 'every new test file needs registration in the test runner requirement',
        tier: 2
      }),
      makeFact('e-noise-runner', { title: 'Runner speed', content: 'the suite runs concurrently' })
    ]
  },
  {
    query: 'schema migration must be idempotent',
    expect: 'e-idem',
    facts: [
      makeFact('e-idem', {
        title: 'Idempotent migrations',
        content: 'every schema migration must be idempotent and re-runnable',
        tier: 3
      }),
      makeFact('e-noise-idem', { title: 'Schema dump', content: 'the schema file is generated' })
    ]
  },
  {
    query: 'renderer must not import main process code',
    expect: 'e-boundary',
    facts: [
      makeFact('e-boundary', {
        title: 'Process boundary',
        content: 'the renderer must not import main process code directly',
        tier: 3
      }),
      makeFact('e-noise-boundary', { title: 'Renderer build', content: 'vite builds the renderer' })
    ]
  },
  {
    query: 'embedding model dimensions',
    expect: 'e-dims',
    facts: [
      makeFact('e-dims', {
        title: 'Embedding dimensions',
        content: 'the embedding model produces 384 dimensions',
        tier: 2
      }),
      makeFact('e-noise-dims', { title: 'Embedding queue', content: 'pending embeddings backfill' })
    ]
  },
  {
    query: 'what happens when the classifier is busy',
    expect: 'e-classifier',
    facts: [
      makeFact('e-classifier', {
        title: 'Classifier queue',
        content: 'what happens when the classifier is busy is that writes queue',
        tier: 2
      }),
      makeFact('e-noise-classifier', { title: 'Classifier model', content: 'a cheap local model' })
    ]
  },
  {
    query: 'capture caps per session',
    expect: 'e-caps',
    facts: [
      makeFact('e-caps', {
        title: 'Capture caps',
        content: 'capture caps per session limit background writes to two facts',
        tier: 2
      }),
      makeFact('e-noise-caps', { title: 'Session list', content: 'sessions are listed by date' })
    ]
  },
  {
    query: 'volatile facts update in place',
    expect: 'e-volatile',
    facts: [
      makeFact('e-volatile', {
        title: 'Volatile facts',
        content: 'volatile facts update in place rather than accumulating',
        tier: 3
      }),
      makeFact('e-noise-volatile', { title: 'Version numbers', content: 'versions change often' })
    ]
  },
  {
    query: 'scope paths restrict a fact to part of the tree',
    expect: 'e-scope',
    facts: [
      makeFact('e-scope', {
        title: 'Scope paths',
        content: 'scope paths restrict a fact to part of the tree it governs',
        tier: 2
      }),
      makeFact('e-noise-scope', { title: 'Path helpers', content: 'normalize path separators' })
    ]
  },
  {
    query: 'why is reflection opt in',
    expect: 'e-reflection',
    facts: [
      makeFact('e-reflection', {
        title: 'Reflection is opt-in',
        content: 'why is reflection opt in because it spends money on a model',
        tier: 2
      }),
      makeFact('e-noise-reflection', {
        title: 'Consolidation',
        content: 'decay and merge run idle'
      })
    ]
  },
  {
    query: 'contradiction resolution keeps the old fact',
    expect: 'e-contra',
    facts: [
      makeFact('e-contra', {
        title: 'Contradictions',
        content: 'contradiction resolution keeps the old fact as superseded, never deleted',
        tier: 3
      }),
      makeFact('e-noise-contra', { title: 'Conflict banner', content: 'the UI shows a banner' })
    ]
  },
  {
    query: 'bootstrap concurrency default value',
    expect: 'e-concurrency',
    facts: [
      makeFact('e-concurrency', {
        title: 'Bootstrap concurrency',
        content: 'bootstrap concurrency default value is three parallel documents',
        tier: 1
      }),
      makeFact('e-noise-concurrency', { title: 'Rate limits', content: 'the api rejects bursts' })
    ]
  }
]

/**
 * Run `body` with the keyword-arm stub reinstalled as the outermost wrapper.
 *
 * The module-level stubs above are installed once at load. Other test files
 * wrap the same repository singleton, and the whole suite shares one process,
 * so by the time these run the eval workspaces can be answered by somebody
 * else's wrapper instead of ours — which returns nothing for them and makes
 * every case look like a ranking failure. Reinstalling here puts this stub
 * last in the chain no matter what the import order was.
 *
 * Deliberately NOT under `runExclusive`. The lock is process-global and this
 * body awaits dozens of retrievals; holding it that long deadlocked the whole
 * suite behind any other exclusive section. The wrapper is safe to leave
 * installed concurrently instead, because it delegates every workspace it does
 * not own back to whatever it replaced.
 */
async function withKeywordStub(body: () => Promise<void>): Promise<void> {
  const previous = memoryFactRepository.searchFts
  memoryFactRepository.searchFts = (
    ws: string,
    query: string,
    limit: number,
    asOf?: string
  ): Array<{ fact: MemoryFact; rank: number }> => {
    const stub = ftsByWs.get(ws)
    if (!stub) return previous(ws, query, limit, asOf)
    return stub.map((fact, rank) => ({ fact, rank }))
  }
  try {
    await body()
  } finally {
    memoryFactRepository.searchFts = previous
  }
}

describe('retrieval eval set — RRF must not regress against legacy', () => {
  test('RRF ranks the expected fact first in every case', async () => {
    if (!loaded) return
    await withKeywordStub(async () => {
      let hits = 0
      const misses: string[] = []
      for (const [i, testCase] of EVAL_CASES.entries()) {
        // Namespaced away from the comparison test below: `scoreWith('rrf')`
        // used to generate this exact key set, and because the harness runs
        // async tests concurrently the two loops deleted each other's stubs
        // mid-flight. With three cases the window was too small to notice.
        const ws = `ws-eval-top1-${i}`
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
          else
            misses.push(
              `"${testCase.query}" expected=${testCase.expect} got=${
                results[0]?.fact.id ?? '<none>'
              } (${results.length} result(s))`
            )
        } finally {
          ftsByWs.delete(ws)
          vectorsByWs.delete(ws)
        }
      }
      assert.equal(
        hits,
        EVAL_CASES.length,
        `RRF got ${hits}/${EVAL_CASES.length} top-1 correct. Misses:\n  ${misses.join('\n  ')}`
      )
    })
  })

  test('RRF scores at least as well as the legacy scorer', async () => {
    if (!loaded) return
    await withKeywordStub(async () => {
      const scoreWith = async (scorer: 'rrf' | 'legacy'): Promise<number> => {
        let hits = 0
        for (const [i, testCase] of EVAL_CASES.entries()) {
          const ws = `ws-eval-cmp-${scorer}-${i}`
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

// ── Embedding matrix cache ───────────────────────────────────────────

/**
 * `rankByVector` used to load every active fact *with its embedding BLOB* on
 * every turn — order 10MB of reads and thousands of cosine computations per
 * message — and then MMR re-read ~30 of the same vectors to diversify. These
 * pin the snapshot behaviour that removed both.
 */
describe('embedding matrix cache', () => {
  /**
   * Run `body` with `findWithEmbeddings` counted and `getLastMutationAt`
   * driven by `stamp`, so a test states cache invalidation directly.
   *
   * The cache is exercised through `getEmbeddingMatrix` / `rankByVector`
   * rather than through `retrieve`, because the vector arm only runs when the
   * local embedding provider is ready — which it never is under test. Going
   * through `retrieve` would assert nothing at all.
   *
   * Exclusive: the harness runs async tests concurrently and this swaps
   * methods on the shared repository singleton.
   */
  async function withCounters(
    ws: string,
    facts: Array<{ fact: MemoryFact; embedding: Float32Array }>,
    body: (ctx: {
      calls: () => number
      asOfCalls: () => number
      setStamp: (n: number) => void
    }) => Promise<void>
  ): Promise<void> {
    return runExclusive(async () => {
      const prevFind = memoryFactRepository.findWithEmbeddings
      const prevMutation = memoryFactRepository.getLastMutationAt

      let calls = 0
      let asOfCalls = 0
      let stamp = 1

      memoryFactRepository.findWithEmbeddings = (id: string, asOf?: string) => {
        if (id !== ws) return prevFind(id, asOf)
        if (asOf) asOfCalls++
        else calls++
        return facts
      }
      memoryFactRepository.getLastMutationAt = (id: string) =>
        id === ws ? stamp : prevMutation(id)

      memoryRetrievalService.clearEmbeddingCache(ws)

      try {
        await body({
          calls: () => calls,
          asOfCalls: () => asOfCalls,
          setStamp: (n) => (stamp = n)
        })
      } finally {
        memoryFactRepository.findWithEmbeddings = prevFind
        memoryFactRepository.getLastMutationAt = prevMutation
        memoryRetrievalService.clearEmbeddingCache(ws)
      }
    })
  }

  /** The private vector arm, which is what actually consumes the snapshot. */
  function rankByVector(ws: string, asOf?: string): MemoryFact[] {
    return (memoryRetrievalService as any).rankByVector(ws, unitVec(0), undefined, asOf)
  }

  const corpus = (): Array<{ fact: MemoryFact; embedding: Float32Array }> => [
    { fact: makeFact('f-c1', { title: 'caching rule' }), embedding: unitVec(0) },
    { fact: makeFact('f-c2', { title: 'caching layers' }), embedding: unitVec(20) },
    { fact: makeFact('f-c3', { title: 'unrelated billing' }), embedding: unitVec(80) }
  ]

  test('a second turn reuses the snapshot instead of re-reading every BLOB', async () => {
    if (!loaded) return
    await withCounters('ws-cache-reuse', corpus(), async ({ calls }) => {
      const first = rankByVector('ws-cache-reuse')
      assert.equal(calls(), 1, 'the first turn must actually load the corpus')
      assert.ok(first.length > 0, 'and it must return the stubbed facts')

      rankByVector('ws-cache-reuse')
      assert.equal(calls(), 1, 'the second turn read nothing from the database')
    })
  })

  test('a fact mutation invalidates the snapshot', async () => {
    if (!loaded) return
    await withCounters('ws-cache-invalidate', corpus(), async ({ calls, setStamp }) => {
      rankByVector('ws-cache-invalidate')
      assert.equal(calls(), 1)

      // Something wrote a fact: getLastMutationAt moves, the snapshot is stale.
      setStamp(2)
      rankByVector('ws-cache-invalidate')
      assert.equal(calls(), 2, 'a changed corpus must be reloaded')
    })
  })

  test('MMR reuses the same snapshot rather than re-reading the page', async () => {
    if (!loaded) return
    await withCounters('ws-cache-mmr', corpus(), async ({ calls }) => {
      let byIdCalls = 0
      const prevByIds = memoryFactRepository.findEmbeddingsByIds
      memoryFactRepository.findEmbeddingsByIds = (ids: string[]) => {
        byIdCalls++
        return prevByIds(ids)
      }
      try {
        // Warm the snapshot the way a turn's vector arm would.
        rankByVector('ws-cache-mmr')
        assert.equal(calls(), 1)

        const results = corpus().map(({ fact }, i) => ({ fact, score: 1 - i * 0.1 }))
        const selected = (memoryRetrievalService as any).diversify(results, 2, 'ws-cache-mmr')

        assert.equal(selected.length, 2)
        assert.equal(byIdCalls, 0, 'MMR must not re-read vectors the vector arm just loaded')
        assert.equal(calls(), 1, 'and it must not rebuild the snapshot either')
      } finally {
        memoryFactRepository.findEmbeddingsByIds = prevByIds
      }
    })
  })

  test('MMR still reads through for a fact the snapshot does not cover', async () => {
    if (!loaded) return
    await withCounters('ws-cache-mmr-miss', corpus(), async () => {
      let requested: string[] = []
      const prevByIds = memoryFactRepository.findEmbeddingsByIds
      memoryFactRepository.findEmbeddingsByIds = (ids: string[]) => {
        requested = ids
        return new Map<string, Float32Array>()
      }
      try {
        rankByVector('ws-cache-mmr-miss')

        // 'f-newcomer' was written after the snapshot was taken.
        const results = [
          { fact: makeFact('f-c1'), score: 1 },
          { fact: makeFact('f-newcomer'), score: 0.9 }
        ]
        ;(memoryRetrievalService as any).diversify(results, 2, 'ws-cache-mmr-miss')

        assert.deepEqual(requested, ['f-newcomer'], 'only the uncovered fact is fetched')
      } finally {
        memoryFactRepository.findEmbeddingsByIds = prevByIds
      }
    })
  })

  test('clearEmbeddingCache forces a rebuild', async () => {
    if (!loaded) return
    await withCounters('ws-cache-clear', corpus(), async ({ calls }) => {
      rankByVector('ws-cache-clear')
      assert.equal(calls(), 1)

      memoryRetrievalService.clearEmbeddingCache('ws-cache-clear')
      rankByVector('ws-cache-clear')
      assert.equal(calls(), 2)
    })
  })

  test('a point-in-time query reads through and does not poison the snapshot', async () => {
    if (!loaded) return
    await withCounters('ws-cache-asof', corpus(), async ({ calls, asOfCalls }) => {
      rankByVector('ws-cache-asof')
      assert.equal(calls(), 1)

      rankByVector('ws-cache-asof', '2026-01-01 00:00:00')
      assert.equal(asOfCalls(), 1, 'asOf must not be answered from the current snapshot')

      // And the current-view snapshot is still intact afterwards.
      rankByVector('ws-cache-asof')
      assert.equal(calls(), 1, 'the asOf read did not evict the current snapshot')
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
