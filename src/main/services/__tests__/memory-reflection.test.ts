/**
 * memory-reflection.test.ts
 *
 * C2: synthesis of many shallow facts into one useful parent.
 *
 * The parsing and scope-merging helpers are pure and tested directly. The
 * clustering and review-queue behaviour is tested through stubbed repository
 * reads, because the point of the design is that nothing reaches a prompt
 * before a human approves it — that gate is what these tests defend.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync, runExclusive } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact } from '../../../shared/types'

setupElectronStub()

let reflection: any
let loaded = false

try {
  require('../../db/index')
  // An earlier file in the shared run loads this service while setup-full-mock's
  // Module._load patch is active, caching it bound to MOCK repositories. The
  // recorders below patch the REAL memoryFactRepository, so without this the
  // service writes to a stub and every recorded-call assertion sees nothing.
  for (const key of Object.keys(require.cache)) {
    if (key.includes('memory-reflection.service')) delete require.cache[key]
  }
  reflection = require('../memory-reflection.service')
  loaded = true
} catch (err) {
  console.error('[memory-reflection] module load failed:', err)
}

// ── Fixture ─────────────────────────────────────────────────────────────────

function makeFact(id: string, overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id,
    workspaceId: 'ws-reflect',
    category: 'convention',
    title: `Title ${id}`,
    content: `Content ${id}`,
    tags: [],
    scopePaths: [],
    tier: 1,
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

/** Unit vector at an angle — states cluster geometry directly. */
function unitVec(angleDeg: number): Float32Array {
  const rad = (angleDeg * Math.PI) / 180
  return new Float32Array([Math.cos(rad), Math.sin(rad)])
}

/**
 * Cluster geometry is passed straight into `findClusters` rather than stubbed
 * onto the repository singleton: the shared runner resets module mocks between
 * files, so a monkey-patch can end up on a different object than the service
 * actually reads from.
 */
function embedded(
  entries: Array<[string, number, Partial<MemoryFact>?]>
): Array<{ fact: MemoryFact; embedding: Float32Array }> {
  return entries.map(([id, angle, overrides]) => ({
    fact: makeFact(id, overrides),
    embedding: unitVec(angle)
  }))
}

// ── parseSynthesis ──────────────────────────────────────────────────────────

describe('parseSynthesis', () => {
  test('module loaded (guards against vacuous passes below)', () => {
    assert.equal(loaded, true, 'memory-reflection.service must be requireable')
  })

  test('parses a clean JSON reply', () => {
    if (!loaded) return
    const out = reflection.parseSynthesis(
      '{"category":"convention","title":"Use Result types","content":"All service methods return Result<T, E> so callers handle failure explicitly."}'
    )
    assert.equal(out.category, 'convention')
    assert.equal(out.title, 'Use Result types')
  })

  test('tolerates a code fence and surrounding prose', () => {
    if (!loaded) return
    const out = reflection.parseSynthesis(
      'Here you go:\n```json\n{"category":"gotcha","title":"Native module crash","content":"onnxruntime-node crashes in Electron, so the web WASM build is patched in."}\n```\nHope that helps.'
    )
    assert.equal(out.category, 'gotcha')
  })

  test('returns null for the explicit NONE refusal', () => {
    if (!loaded) return
    assert.equal(reflection.parseSynthesis('NONE'), null)
    assert.equal(reflection.parseSynthesis('  none  '), null)
  })

  test('returns null for unparseable output', () => {
    if (!loaded) return
    assert.equal(reflection.parseSynthesis('I think these are all about caching.'), null)
    assert.equal(reflection.parseSynthesis(''), null)
    assert.equal(reflection.parseSynthesis('{ broken json'), null)
  })

  test('rejects a reply too short to be a real fact', () => {
    if (!loaded) return
    assert.equal(
      reflection.parseSynthesis('{"category":"convention","title":"X","content":"short"}'),
      null
    )
  })

  test('falls back to convention for an unknown category', () => {
    if (!loaded) return
    const out = reflection.parseSynthesis(
      '{"category":"nonsense","title":"Some rule","content":"A sufficiently long body describing the rule."}'
    )
    assert.equal(out.category, 'convention')
  })
})

// ── mergeScopePaths ─────────────────────────────────────────────────────────

describe('mergeScopePaths', () => {
  test('unions the children scope paths', () => {
    if (!loaded) return
    const merged = reflection.mergeScopePaths([
      makeFact('a', { scopePaths: ['src/api', 'src/db'] }),
      makeFact('b', { scopePaths: ['src/db', 'src/ui'] })
    ])
    assert.deepEqual(merged.sort(), ['src/api', 'src/db', 'src/ui'])
  })

  test('caps at ten entries', () => {
    if (!loaded) return
    const facts = Array.from({ length: 20 }, (_, i) =>
      makeFact(`f${i}`, { scopePaths: [`src/m${i}`] })
    )
    assert.equal(reflection.mergeScopePaths(facts).length, 10)
  })

  test('returns empty for unscoped facts', () => {
    if (!loaded) return
    assert.deepEqual(reflection.mergeScopePaths([makeFact('a')]), [])
  })
})

// ── Cluster selection ───────────────────────────────────────────────────────

describe('findClusters', () => {
  test('finds a cluster of related-but-distinct facts', () => {
    if (!loaded) return
    const clusters = reflection.memoryReflectionService.findClusters(
      'ws-reflect',
      embedded([
        ['c1', 0],
        ['c2', 15],
        ['c3', 28]
      ])
    )
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].facts.length, 3)
  })

  test('ignores a pair — two facts are a merge, not a theme', () => {
    if (!loaded) return
    assert.deepEqual(
      reflection.memoryReflectionService.findClusters(
        'ws-reflect',
        embedded([
          ['p1', 0],
          ['p2', 15]
        ])
      ),
      []
    )
  })

  test('skips near-identical clusters — those are deduplication, not synthesis', () => {
    if (!loaded) return
    assert.deepEqual(
      reflection.memoryReflectionService.findClusters(
        'ws-reflect',
        embedded([
          ['d1', 0],
          ['d2', 1],
          ['d3', 2]
        ])
      ),
      []
    )
  })

  test('excludes previously synthesised parents from becoming children', () => {
    if (!loaded) return
    // Only two non-synthesis facts remain, which is below the minimum.
    const clusters = reflection.memoryReflectionService.findClusters(
      'ws-reflect',
      embedded([
        ['n1', 0],
        ['n2', 15],
        ['n3', 28, { tags: [reflection.SYNTHESIS_TAG] }]
      ])
    )
    assert.deepEqual(clusters, [], 'a synthesised parent is not re-summarised')
  })

  test('ignores unrelated facts', () => {
    if (!loaded) return
    assert.deepEqual(
      reflection.memoryReflectionService.findClusters(
        'ws-reflect',
        embedded([
          ['u1', 0],
          ['u2', 80],
          ['u3', 160]
        ])
      ),
      []
    )
  })
})

// ── Opt-in gate ─────────────────────────────────────────────────────────────

describe('reflection opt-in', () => {
  test('is disabled by default', () => {
    if (!loaded) return
    assert.equal(
      reflection.memoryReflectionService.isEnabled('ws-does-not-exist'),
      false,
      'reflection spends money, so it must never be on by accident'
    )
  })

  test('runReflection does nothing for a workspace that has not opted in', async () => {
    if (!loaded) return
    const result = await reflection.memoryReflectionService.runReflection(
      'ws-does-not-exist',
      '/tmp/nowhere'
    )
    assert.deepEqual(result, { clustersConsidered: 0, parentsProposed: 0, errors: 0 })
  })
})

// ── synthesizeCluster ───────────────────────────────────────────────

/**
 * The write-and-archive path. It was previously untested, and it contained the
 * defect these tests now pin: a synthesised parent sits close to its children
 * by construction, so routing it through the dedup pipeline resolves it to one
 * of those children — and the archive that follows then destroys a real fact.
 */
describe('synthesizeCluster', () => {
  const REPLY =
    '{"category":"convention","title":"Services return Result types",' +
    '"content":"Every service method returns Result<T, E> so callers must handle failure explicitly."}'

  /** Stub runner returning fixed stdout, recording the options it was given. */
  function stubRunner(stdout: string, calls: any[] = []): any {
    return async (opts: any) => {
      calls.push(opts)
      return { stdout, stderr: '', exitCode: 0 }
    }
  }

  function makeCluster(): any {
    return {
      facts: [makeFact('s1'), makeFact('s2'), makeFact('s3')],
      meanSimilarity: 0.88
    }
  }

  /**
   * Patch the two singletons synthesis writes through, run `body`, restore.
   * `writeFact` decides what the engine hands back; the recorder captures
   * every archive and edge so a test can assert on what was *not* touched.
   *
   * `runExclusive` because the harness starts async tests concurrently and
   * these all swap methods on the same two module singletons — without the
   * lock they restore each other's stubs across await points.
   */
  async function withStubbedWrites(
    writeFact: (params: any) => Promise<any>,
    body: (recorded: { archived: string[]; edges: any[]; writes: any[] }) => Promise<void>
  ): Promise<void> {
    return runExclusive(async () => {
      const engine = require('../memory-engine.service').memoryEngineService
      const repo = require('../../db/repositories/memory-fact.repository').memoryFactRepository

      const originalWrite = engine.writeFact
      const originalArchive = repo.archiveFact
      const originalCreateEdge = repo.createEdge

      const recorded = { archived: [] as string[], edges: [] as any[], writes: [] as any[] }

      engine.writeFact = async (params: any) => {
        recorded.writes.push(params)
        return writeFact(params)
      }
      repo.archiveFact = (id: string) => {
        recorded.archived.push(id)
      }
      repo.createEdge = (edge: any) => {
        recorded.edges.push(edge)
        return edge
      }

      try {
        await body(recorded)
      } finally {
        engine.writeFact = originalWrite
        repo.archiveFact = originalArchive
        repo.createEdge = originalCreateEdge
      }
    })
  }

  test('writes an archived proposal and links it to every source fact', async () => {
    if (!loaded) return
    await withStubbedWrites(
      async (params) => makeFact('parent-new', { tags: params.tags, status: 'active' }),
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner(REPLY)
        )

        assert.equal(created, true)
        assert.deepEqual(recorded.archived, ['parent-new'], 'the proposal is archived, not visible')
        assert.equal(recorded.edges.length, 3, 'one derived_from edge per source fact')
        assert.deepEqual(recorded.edges.map((e) => e.toId).sort(), ['s1', 's2', 's3'])
        assert.ok(recorded.edges.every((e) => e.edgeType === 'derived_from'))
        assert.deepEqual(
          recorded.edges.map((e) => e.fromId),
          ['parent-new', 'parent-new', 'parent-new']
        )
      }
    )
  })

  test('bypasses the dedup pipeline — a parent is near its children by construction', async () => {
    if (!loaded) return
    await withStubbedWrites(
      async (params) => makeFact('parent-new', { tags: params.tags }),
      async (recorded) => {
        await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner(REPLY)
        )

        assert.equal(recorded.writes.length, 1)
        assert.equal(
          recorded.writes[0].skipSimilarity,
          true,
          'without this the pipeline returns a child fact as a "duplicate"'
        )
      }
    )
  })

  test('refuses to archive when the write resolves to an existing fact', async () => {
    if (!loaded) return
    // Exactly the D1 collision: the engine hands back one of the cluster
    // children instead of a new proposal. Archiving it would delete a real,
    // possibly long-established fact and hang edges off the corpse.
    await withStubbedWrites(
      async () => makeFact('s2'),
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner(REPLY)
        )

        assert.equal(created, false, 'a collision is a skipped proposal, not a write')
        assert.deepEqual(recorded.archived, [], 'the source fact survives')
        assert.deepEqual(recorded.edges, [], 'no edges point at it')
      }
    )
  })

  test('refuses to archive a returned fact missing the proposal tags', async () => {
    if (!loaded) return
    // A fact outside the cluster can also come back from a dedup confirm. The
    // id check alone would not catch it; the tag check does.
    await withStubbedWrites(
      async () => makeFact('unrelated-established-fact', { tags: ['billing'] }),
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner(REPLY)
        )

        assert.equal(created, false)
        assert.deepEqual(recorded.archived, [])
        assert.deepEqual(recorded.edges, [])
      }
    )
  })

  test('writes nothing when the model refuses with NONE', async () => {
    if (!loaded) return
    await withStubbedWrites(
      async () => makeFact('should-not-happen'),
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner('NONE')
        )

        assert.equal(created, false)
        assert.deepEqual(recorded.writes, [], 'a refusal must not reach the database')
        assert.deepEqual(recorded.archived, [])
      }
    )
  })

  test('writes nothing when the model returns unparseable output', async () => {
    if (!loaded) return
    await withStubbedWrites(
      async () => makeFact('should-not-happen'),
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner('I think these are all about caching.')
        )

        assert.equal(created, false)
        assert.deepEqual(recorded.writes, [])
      }
    )
  })

  test('returns false rather than throwing when the engine writes nothing', async () => {
    if (!loaded) return
    // writeFact returns null when a capture cap is hit.
    await withStubbedWrites(
      async () => null,
      async (recorded) => {
        const created = await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          makeCluster(),
          stubRunner(REPLY)
        )

        assert.equal(created, false)
        assert.deepEqual(recorded.archived, [])
      }
    )
  })

  test('caps the facts sent to the model and tags the proposal for review', async () => {
    if (!loaded) return
    const calls: any[] = []
    await withStubbedWrites(
      async (params) => makeFact('parent-new', { tags: params.tags }),
      async (recorded) => {
        const big = {
          facts: Array.from({ length: 30 }, (_, i) => makeFact(`b${i}`)),
          meanSimilarity: 0.9
        }
        await reflection.memoryReflectionService.synthesizeCluster(
          'ws-reflect',
          '/tmp/ws',
          big,
          stubRunner(REPLY, calls)
        )

        assert.equal(recorded.edges.length, 12, 'MAX_FACTS_PER_PROMPT bounds the cost')
        assert.deepEqual(recorded.writes[0].tags, [
          reflection.SYNTHESIS_TAG,
          reflection.PENDING_REVIEW_TAG
        ])
        assert.equal(calls.length, 1)
        assert.deepEqual(calls[0].allowedTools, [], 'synthesis reads no files')
      }
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
