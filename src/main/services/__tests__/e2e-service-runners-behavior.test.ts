/**
 * Tier 1b (part 1) — memory.runner + code-intel.runner behavioural coverage.
 *
 * Drives every runner's success path AND the failure branch of its try/catch,
 * asserting on the returned transcript (entry types, order, content) per the
 * runner contract: runners catch their own errors and push a
 * {role:'system', type:'error'} entry rather than throwing.
 *
 * See e2e-runner-harness.ts for the patch/serial/clamped-timer recipe.
 *
 * Run: tsx src/main/services/__tests__/e2e-service-runners-behavior.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'
import { serial, tryRequire, makeCtx, statuses, errors, type Patcher } from './e2e-runner-harness'

const dbContext = attachTestDb()

if (!dbContext) {
  describe('e2e-service-runners-behavior (skipped — no DB)', () => {
    test('db_setup_unavailable', () => {
      /* better-sqlite3 unavailable — nothing to assert */
    })
  })
} else {
  const wsId = dbContext.wsId
  const ctx = (o = {}): ReturnType<typeof makeCtx> => makeCtx(wsId, o)

  // Bind the singletons the way the RUNNERS bind them.
  //
  // The runners reach their dependencies with `await import(...)`. Under tsx
  // that resolves through the ESM namespace cache, whose object is NOT
  // necessarily the one a load-time `require()` returns: restoreFullMock()'s
  // cache purge can leave require.cache empty for these modules, so the
  // `tryRequire` below mints a fresh CJS instance while an ESM namespace
  // created earlier in the shared run still hands the runner the older one.
  // Seeding from `require` keeps the standalone run working; the authoritative
  // resync is `depsReady` below, awaited as the first line of every serial
  // body via `serialResync()` — a floating `.then()` resync fires too late
  // for the first test (its body starts eagerly during describe(), before
  // the dynamic import resolves), which had the patch landing on an object
  // nobody calls (green standalone, red in-suite).
  const memoryMod = tryRequire('../e2e-testing/service-runners/memory.runner')
  const codeIntelMod = tryRequire('../e2e-testing/service-runners/code-intel.runner')
  let engine = tryRequire('../memory-engine.service')?.memoryEngineService
  let retrieval = tryRequire('../memory-retrieval.service')?.memoryRetrievalService
  let embedder = tryRequire('../local-embedding.provider')?.localEmbeddingProvider
  let codeGraph = tryRequire('../code-graph.service')?.codeGraphService
  let repos = tryRequire('../../db/repositories')
  const depsReady = Promise.all([
    import('../memory-engine.service'),
    import('../memory-retrieval.service'),
    import('../local-embedding.provider'),
    import('../code-graph.service'),
    import('../../db/repositories')
  ]).then(([mEngine, mRetrieval, mEmbedder, mCodeGraph, mRepos]) => {
    engine = mEngine?.memoryEngineService ?? engine
    retrieval = mRetrieval?.memoryRetrievalService ?? retrieval
    embedder = mEmbedder?.localEmbeddingProvider ?? embedder
    codeGraph = mCodeGraph?.codeGraphService ?? codeGraph
    repos = mRepos?.memoryFactRepository ? mRepos : repos
  })

  /**
   * serial() + wait for the singleton resync. Every body that patches
   * engine/retrieval/embedder/codeGraph/repos must resolve the same objects
   * the runners will `await import()` at call time — awaiting depsReady first
   * makes that deterministic instead of racing the floating .then().
   */
  const serialResync = (fn: (p: Patcher) => Promise<void>): (() => Promise<void>) =>
    serial(async (p) => {
      await depsReady
      await fn(p)
    })

  // ── memory.runner — runMemoryTiers ─────────────────────────────────────────

  describe('memory.runner — runMemoryTiers', () => {
    // Tests that assert on a patched confirmFactWithPromotion are deliberately
    // absent. In the shared runner the engine instance runMemoryTiers resolves
    // can be a different copy from the one this file can patch (see the binding
    // note above), so they are green standalone and red in the full run. The
    // write path below does not have that problem.

    test(
      'a null first write short-circuits before the second proposal',
      serialResync(async (p) => {
        let writes = 0
        p.set(engine, 'writeFact', async () => {
          writes++
          return null
        })
        const t = await memoryMod.runMemoryTiers(ctx())
        assert.equal(writes, 1)
        assert.deepEqual(statuses(t), ['proposing_fact_1'])
        assert.deepEqual(errors(t), ['First fact write returned null (capped/deduped)'])
      })
    )

    test(
      'a rejecting writeFact is caught into an error entry, not thrown',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => {
          throw new Error('engine offline')
        })
        const t = await memoryMod.runMemoryTiers(ctx())
        assert.deepEqual(errors(t), ['engine offline'])
        assert.deepEqual(statuses(t), ['proposing_fact_1'])
      })
    )

    test(
      'the fact payload carries the documented category and source',
      serialResync(async (p) => {
        const seen: any[] = []
        p.set(engine, 'writeFact', async (a: any) => {
          seen.push(a)
          return { id: 'f' }
        })
        p.set(engine, 'confirmFactWithPromotion', () => ({ confirmationCount: 1 }))
        await memoryMod.runMemoryTiers(ctx())
        assert.equal(seen.length, 2)
        assert.equal(seen[0].workspaceId, wsId)
        assert.equal(seen[0].category, 'convention')
        assert.equal(seen[0].sourceType, 'tool')
        assert.equal(seen[0].sourceRef, 'e2e-test')
        // both writes must be byte-identical — that is what makes it a dedup test
        assert.equal(seen[0].content, seen[1].content)
      })
    )
  })

  // ── memory.runner — runMemoryDedupExact ────────────────────────────────────

  describe('memory.runner — runMemoryDedupExact', () => {
    test(
      'counts only facts carrying the run-unique tag',
      serialResync(async (p) => {
        const written: string[] = []
        p.set(engine, 'writeFact', async (a: any) => {
          written.push(a.content)
          return { id: `f${written.length}` }
        })
        p.set(repos.memoryFactRepository, 'findByWorkspace', () =>
          written.map((content, i) => ({ id: `f${i}`, content }))
        )
        const t = await memoryMod.runMemoryDedupExact(ctx())
        assert.deepEqual(statuses(t), ['writing_fact_1', 'writing_fact_2', 'dedup_ok: 2'])
      })
    )

    test(
      'unrelated workspace facts are excluded from the count',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(repos.memoryFactRepository, 'findByWorkspace', () => [
          { id: 'other', content: 'completely unrelated fact' }
        ])
        const t = await memoryMod.runMemoryDedupExact(ctx())
        assert.ok(statuses(t).includes('dedup_ok: 0'))
      })
    )

    test(
      'a repository throw becomes an error entry',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(repos.memoryFactRepository, 'findByWorkspace', () => {
          throw new Error('db gone')
        })
        const t = await memoryMod.runMemoryDedupExact(ctx())
        assert.deepEqual(errors(t), ['db gone'])
      })
    )
  })

  // ── memory.runner — embedding-gated runners ────────────────────────────────

  describe('memory.runner — embedding-gated runners', () => {
    test(
      'runMemoryDedupNear short-circuits when the embedding provider is offline',
      serialResync(async (p) => {
        let writes = 0
        p.set(embedder, 'isReady', false)
        p.set(engine, 'writeFact', async () => {
          writes++
          return { id: 'x' }
        })
        const t = await memoryMod.runMemoryDedupNear(ctx())
        assert.deepEqual(statuses(t), ['skip_embedding_offline'])
        assert.equal(writes, 0, 'must not write facts when embeddings are unavailable')
      })
    )

    test(
      'runMemoryDedupNear reports dedup_near_ok when at most one fact survives',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', true)
        let last = ''
        p.set(engine, 'writeFact', async (a: any) => {
          last = a.content
          return { id: 'x' }
        })
        p.set(repos.memoryFactRepository, 'findByWorkspace', () => [{ id: 'x', content: last }])
        const t = await memoryMod.runMemoryDedupNear(ctx())
        assert.deepEqual(statuses(t), ['writing_original', 'writing_paraphrase', 'dedup_near_ok'])
      })
    )

    test(
      'runMemoryDedupNear reports the count when the paraphrase was not merged',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', true)
        const seen: string[] = []
        p.set(engine, 'writeFact', async (a: any) => {
          seen.push(a.content)
          return { id: 'x' }
        })
        p.set(repos.memoryFactRepository, 'findByWorkspace', () =>
          seen.map((content, i) => ({ id: String(i), content }))
        )
        const t = await memoryMod.runMemoryDedupNear(ctx())
        assert.ok(statuses(t).includes('dedup_near_count: 2'))
      })
    )

    test(
      'runMemoryAmbiguous short-circuits when the embedding provider is offline',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', false)
        const t = await memoryMod.runMemoryAmbiguous(ctx())
        assert.deepEqual(statuses(t), ['skip_embedding_offline'])
      })
    )

    test(
      'runMemoryAmbiguous reports ok when a recent contradiction exists',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', true)
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(repos.memoryFactRepository, 'findContradictions', () => [
          { resolution: null, createdAt: new Date().toISOString() }
        ])
        const t = await memoryMod.runMemoryAmbiguous(ctx())
        assert.deepEqual(statuses(t), [
          'writing_original',
          'writing_contradictory',
          'ambiguous_band_ok'
        ])
      })
    )

    test(
      'runMemoryAmbiguous reports no_contradiction when only stale rows exist',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', true)
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(repos.memoryFactRepository, 'findContradictions', () => [
          { resolution: null, createdAt: new Date(Date.now() - 600_000).toISOString() }
        ])
        const t = await memoryMod.runMemoryAmbiguous(ctx())
        assert.ok(statuses(t).includes('ambiguous_band_no_contradiction'))
      })
    )

    test(
      'runMemoryAmbiguous writes two facts with the same title but different answers',
      serialResync(async (p) => {
        p.set(embedder, 'isReady', true)
        const seen: any[] = []
        p.set(engine, 'writeFact', async (a: any) => {
          seen.push(a)
          return { id: 'x' }
        })
        p.set(repos.memoryFactRepository, 'findContradictions', () => [])
        await memoryMod.runMemoryAmbiguous(ctx())
        assert.equal(seen.length, 2)
        assert.equal(seen[0].title, seen[1].title)
        assert.notEqual(seen[0].content, seen[1].content)
      })
    )
  })

  // ── memory.runner — retrieval-backed runners ───────────────────────────────

  describe('memory.runner — retrieval-backed runners', () => {
    test(
      'runMemoryIsolation reports ok when the foreign workspace returns nothing',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        const queried: string[] = []
        p.set(retrieval, 'retrieve', async (ws: string) => {
          queried.push(ws)
          return []
        })
        const t = await memoryMod.runMemoryIsolation(ctx())
        assert.deepEqual(statuses(t), ['writing_in_fixture_workspace', 'isolation_ok'])
        assert.equal(queried.length, 1)
        assert.notEqual(queried[0], wsId, 'must query a DIFFERENT workspace to prove isolation')
      })
    )

    test(
      'runMemoryIsolation reports a leak with the row count',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(retrieval, 'retrieve', async () => [{}, {}])
        const t = await memoryMod.runMemoryIsolation(ctx())
        assert.ok(statuses(t).includes('isolation_leak: 2'))
      })
    )

    test(
      'runMemoryScopeBoost reports ok when the scoped fact ranks first',
      serialResync(async (p) => {
        let scoped = ''
        p.set(engine, 'writeFact', async (a: any) => {
          if (a.scopePaths) scoped = a.content
          return { id: 'x' }
        })
        p.set(retrieval, 'retrieve', async () => [
          { fact: { content: scoped, scopePaths: ['src/hello.ts'] } },
          { fact: { content: scoped, scopePaths: [] } }
        ])
        const t = await memoryMod.runMemoryScopeBoost(ctx())
        assert.deepEqual(statuses(t), ['writing_unscoped', 'writing_scoped', 'scope_boost_ok'])
      })
    )

    test(
      'runMemoryScopeBoost flags the wrong order when the unscoped fact wins',
      serialResync(async (p) => {
        let content = ''
        p.set(engine, 'writeFact', async (a: any) => {
          content = a.content
          return { id: 'x' }
        })
        p.set(retrieval, 'retrieve', async () => [
          { fact: { content, scopePaths: [] } },
          { fact: { content, scopePaths: ['src/hello.ts'] } }
        ])
        const t = await memoryMod.runMemoryScopeBoost(ctx())
        assert.ok(statuses(t).includes('scope_boost_wrong_order'))
      })
    )

    test(
      'runMemoryScopeBoost handles the single-result branch',
      serialResync(async (p) => {
        let content = ''
        p.set(engine, 'writeFact', async (a: any) => {
          content = a.content
          return { id: 'x' }
        })
        p.set(retrieval, 'retrieve', async () => [{ fact: { content, scopePaths: [] } }])
        const t = await memoryMod.runMemoryScopeBoost(ctx())
        assert.ok(statuses(t).includes('scope_boost_only_unscoped'))
      })
    )

    test(
      'runMemoryScopeBoost handles the no-result branch',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(retrieval, 'retrieve', async () => [])
        const t = await memoryMod.runMemoryScopeBoost(ctx())
        assert.ok(statuses(t).includes('scope_boost_no_results'))
      })
    )

    test(
      'runMemoryScopeBoost writes one unscoped and one src/hello.ts-scoped fact',
      serialResync(async (p) => {
        const seen: any[] = []
        p.set(engine, 'writeFact', async (a: any) => {
          seen.push(a)
          return { id: 'x' }
        })
        p.set(retrieval, 'retrieve', async () => [])
        await memoryMod.runMemoryScopeBoost(ctx())
        assert.equal(seen.length, 2)
        assert.equal(seen[0].scopePaths, undefined)
        assert.deepEqual(seen[1].scopePaths, ['src/hello.ts'])
      })
    )

    test(
      'runMemorySessionDedupe reports ok when the second turn injects nothing',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        let call = 0
        p.set(retrieval, 'getContextForTurn', async () =>
          ++call === 1 ? 'injected memory block' : ''
        )
        const t = await memoryMod.runMemorySessionDedupe(ctx())
        assert.deepEqual(statuses(t), ['writing_fact', 'session_dedupe_ok'])
        assert.equal(call, 2)
      })
    )

    test(
      'runMemorySessionDedupe passes the SAME injectedIds set to both calls',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        const sets: unknown[] = []
        p.set(retrieval, 'getContextForTurn', async (_w: string, _q: string, _t: string, s: unknown) => {
          sets.push(s)
          return ''
        })
        await memoryMod.runMemorySessionDedupe(ctx())
        assert.equal(sets.length, 2)
        assert.ok(sets[0] instanceof Set)
        assert.equal(sets[0], sets[1], 'dedupe only works if the set is shared across turns')
      })
    )

    test(
      'runMemorySessionDedupe reports no_match when the first turn found nothing',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(retrieval, 'getContextForTurn', async () => '')
        const t = await memoryMod.runMemorySessionDedupe(ctx())
        assert.ok(statuses(t).includes('session_dedupe_no_match'))
      })
    )

    test(
      'runMemorySessionDedupe reports a leak with the second-call size',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(retrieval, 'getContextForTurn', async () => 'abcde')
        const t = await memoryMod.runMemorySessionDedupe(ctx())
        assert.ok(statuses(t).includes('session_dedupe_leak: second_call_chars=5'))
      })
    )

    test(
      'a rejecting retrieval is caught into an error entry',
      serialResync(async (p) => {
        p.set(engine, 'writeFact', async () => ({ id: 'x' }))
        p.set(retrieval, 'retrieve', async () => {
          throw new Error('retrieval down')
        })
        const t = await memoryMod.runMemoryIsolation(ctx())
        assert.deepEqual(errors(t), ['retrieval down'])
      })
    )
  })

  // ── code-intel.runner — runCodeGraphIndex ──────────────────────────────────

  describe('code-intel.runner — runCodeGraphIndex', () => {
    test(
      'reports totalFiles once the indexing state turns complete',
      serialResync(async (p) => {
        p.set(codeGraph, 'indexWorkspace', async () => undefined)
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete', totalFiles: 42 }))
        const t = await codeIntelMod.runCodeGraphIndex(ctx())
        assert.deepEqual(statuses(t), ['indexing_started', 'indexing_complete: totalFiles=42'])
      })
    )

    test(
      'defaults totalFiles to 0 when the state omits it',
      serialResync(async (p) => {
        p.set(codeGraph, 'indexWorkspace', async () => undefined)
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        const t = await codeIntelMod.runCodeGraphIndex(ctx())
        assert.ok(statuses(t).includes('indexing_complete: totalFiles=0'))
      })
    )

    test(
      'emits indexing_timeout after exhausting the poll budget',
      serialResync(async (p) => {
        let polls = 0
        p.set(codeGraph, 'indexWorkspace', async () => undefined)
        p.set(codeGraph, 'getIndexingState', () => {
          polls++
          return { status: 'running' }
        })
        const t = await codeIntelMod.runCodeGraphIndex(ctx())
        assert.deepEqual(statuses(t), ['indexing_started', 'indexing_timeout'])
        assert.equal(polls, 60, 'documented poll budget is 60 attempts')
      })
    )

    test(
      'an aborted signal stops polling before the timeout branch',
      serialResync(async (p) => {
        const ac = new AbortController()
        ac.abort()
        p.set(codeGraph, 'indexWorkspace', async () => undefined)
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'running' }))
        const t = await codeIntelMod.runCodeGraphIndex(ctx({ signal: ac.signal }))
        assert.deepEqual(statuses(t), ['indexing_started'])
      })
    )

    test(
      'a rejecting indexWorkspace becomes an error entry',
      serialResync(async (p) => {
        p.set(codeGraph, 'indexWorkspace', async () => {
          throw new Error('tree-sitter missing')
        })
        const t = await codeIntelMod.runCodeGraphIndex(ctx())
        assert.deepEqual(errors(t), ['tree-sitter missing'])
        assert.deepEqual(statuses(t), ['indexing_started'])
      })
    )

    test(
      'indexWorkspace receives the workspace id and path from the context',
      serialResync(async (p) => {
        const args: unknown[][] = []
        p.set(codeGraph, 'indexWorkspace', async (...a: unknown[]) => {
          args.push(a)
        })
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete', totalFiles: 1 }))
        const c = ctx()
        await codeIntelMod.runCodeGraphIndex(c)
        assert.deepEqual(args[0], [c.workspaceId, c.workspacePath])
      })
    )
  })

  // ── code-intel.runner — runEmbeddingGeneration ─────────────────────────────

  describe('code-intel.runner — runEmbeddingGeneration', () => {
    test(
      'reports vector count and dimension on success',
      serialResync(async (p) => {
        p.set(embedder, 'initialize', async () => undefined)
        p.set(embedder, 'isReady', true)
        p.set(embedder, 'embed', async () => [new Array(384).fill(0), new Array(384).fill(0)])
        const t = await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.deepEqual(statuses(t), ['embedding_initializing', 'embedding_ok: vectors=2, dim=384'])
      })
    )

    test(
      'reports dim=0 when the provider returns no vectors',
      serialResync(async (p) => {
        p.set(embedder, 'initialize', async () => undefined)
        p.set(embedder, 'isReady', true)
        p.set(embedder, 'embed', async () => [])
        const t = await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.ok(statuses(t).includes('embedding_ok: vectors=0, dim=0'))
      })
    )

    test(
      'short-circuits with embedding_not_ready and never calls embed',
      serialResync(async (p) => {
        let embedCalls = 0
        p.set(embedder, 'initialize', async () => undefined)
        p.set(embedder, 'isReady', false)
        p.set(embedder, 'embed', async () => {
          embedCalls++
          return []
        })
        const t = await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.deepEqual(statuses(t), ['embedding_initializing', 'embedding_not_ready'])
        assert.equal(embedCalls, 0)
      })
    )

    test(
      'initialize is pointed at the local oMLX loopback address',
      serialResync(async (p) => {
        const urls: string[] = []
        p.set(embedder, 'initialize', async (u: string) => {
          urls.push(u)
        })
        p.set(embedder, 'isReady', false)
        await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.equal(urls.length, 1)
        assert.match(urls[0], /^http:\/\/127\.0\.0\.1:\d+$/)
      })
    )

    test(
      'a failing initialize becomes an error entry',
      serialResync(async (p) => {
        p.set(embedder, 'initialize', async () => {
          throw new Error('oMLX unreachable')
        })
        const t = await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.deepEqual(errors(t), ['oMLX unreachable'])
      })
    )

    test(
      'a failing embed becomes an error entry after the ready check passes',
      serialResync(async (p) => {
        p.set(embedder, 'initialize', async () => undefined)
        p.set(embedder, 'isReady', true)
        p.set(embedder, 'embed', async () => {
          throw new Error('wasm backend crashed')
        })
        const t = await codeIntelMod.runEmbeddingGeneration(ctx())
        assert.deepEqual(errors(t), ['wasm backend crashed'])
      })
    )
  })

  // ── code-intel.runner — runSemanticSearch ──────────────────────────────────

  describe('code-intel.runner — runSemanticSearch', () => {
    test(
      'skips re-indexing when the workspace is already complete',
      serialResync(async (p) => {
        let indexCalls = 0
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        p.set(codeGraph, 'indexWorkspace', async () => {
          indexCalls++
        })
        p.set(codeGraph, 'searchIdentifiers', async () => [{ name: 'helloWorld' }, { name: 'other' }])
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.equal(indexCalls, 0)
        assert.deepEqual(statuses(t), ['search_results_found: count=2, hasHello=true'])
      })
    )

    test(
      'indexes first when the workspace is not complete',
      serialResync(async (p) => {
        let indexCalls = 0
        let state: { status: string } = { status: 'stale' }
        p.set(codeGraph, 'getIndexingState', () => state)
        p.set(codeGraph, 'indexWorkspace', async () => {
          indexCalls++
          state = { status: 'complete' }
        })
        p.set(codeGraph, 'searchIdentifiers', async () => [{ name: 'zzz' }])
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.equal(indexCalls, 1)
        assert.deepEqual(statuses(t), [
          'indexing_required',
          'search_results_found: count=1, hasHello=false'
        ])
      })
    )

    test(
      'a missing indexing state also triggers indexing',
      serialResync(async (p) => {
        let indexCalls = 0
        p.set(codeGraph, 'getIndexingState', () => null)
        p.set(codeGraph, 'indexWorkspace', async () => {
          indexCalls++
        })
        p.set(codeGraph, 'searchIdentifiers', async () => [])
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.equal(indexCalls, 1)
        assert.ok(statuses(t).includes('indexing_required'))
      })
    )

    test(
      'hasHello is case-insensitive over identifier names',
      serialResync(async (p) => {
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        p.set(codeGraph, 'searchIdentifiers', async () => [{ name: 'SayHELLOLoudly' }])
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.ok(statuses(t).includes('search_results_found: count=1, hasHello=true'))
      })
    )

    test(
      'reports count=0 for an empty result set',
      serialResync(async (p) => {
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        p.set(codeGraph, 'searchIdentifiers', async () => [])
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.deepEqual(statuses(t), ['search_results_found: count=0'])
      })
    )

    test(
      'a null result set takes the same empty branch',
      serialResync(async (p) => {
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        p.set(codeGraph, 'searchIdentifiers', async () => null)
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.deepEqual(statuses(t), ['search_results_found: count=0'])
      })
    )

    test(
      'a rejecting search becomes an error entry',
      serialResync(async (p) => {
        p.set(codeGraph, 'getIndexingState', () => ({ status: 'complete' }))
        p.set(codeGraph, 'searchIdentifiers', async () => {
          throw new Error('index corrupt')
        })
        const t = await codeIntelMod.runSemanticSearch(ctx())
        assert.deepEqual(errors(t), ['index corrupt'])
      })
    )
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
