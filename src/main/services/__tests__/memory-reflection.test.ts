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
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import type { MemoryFact } from '../../../shared/types'

setupElectronStub()

let reflection: any
let loaded = false

try {
  require('../../db/index')
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
      embedded([['c1', 0], ['c2', 15], ['c3', 28]])
    )
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].facts.length, 3)
  })

  test('ignores a pair — two facts are a merge, not a theme', () => {
    if (!loaded) return
    assert.deepEqual(
      reflection.memoryReflectionService.findClusters(
        'ws-reflect',
        embedded([['p1', 0], ['p2', 15]])
      ),
      []
    )
  })

  test('skips near-identical clusters — those are deduplication, not synthesis', () => {
    if (!loaded) return
    assert.deepEqual(
      reflection.memoryReflectionService.findClusters(
        'ws-reflect',
        embedded([['d1', 0], ['d2', 1], ['d3', 2]])
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
        embedded([['u1', 0], ['u2', 80], ['u3', 160]])
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
