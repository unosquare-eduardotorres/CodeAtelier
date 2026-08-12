/**
 * facts-model — what the Memories list actually shows.
 *
 * Two rules here have bitten users. Status scoping must never leak superseded
 * facts into the default view (the badge counts active only, so any leak makes
 * the header disagree with the list permanently). And `buildRows` must drop
 * empty tier groups: the page once rendered as four collapsed headers over
 * nothing, which read as "all memories are gone".
 *
 * Run: tsx src/renderer/src/components/workspace/memory/facts/__tests__/facts-model.test.ts
 */
import assert from 'node:assert/strict'
import {
  test,
  describe,
  summaryAsync
} from '../../../../../../../main/services/__tests__/test-harness'
import {
  buildRows,
  countByCategory,
  countByTier,
  narrowAndSort,
  scopeFacts,
  validatedPercent
} from '../facts-model'
import { ALL_CATEGORIES, ALL_TIERS } from '../types'
import type { MemoryFact } from '../../../../../../../shared/types'

let seq = 0

const fact = (partial: Partial<MemoryFact> = {}): MemoryFact => ({
  id: `f${++seq}`,
  workspaceId: 'ws-1',
  category: 'decision',
  title: 'Title',
  content: 'Content',
  tags: [],
  scopePaths: [],
  tier: 0,
  confidence: 0.5,
  confirmationCount: 0,
  lastConfirmedAt: null,
  status: 'active',
  supersededBy: null,
  mergedInto: null,
  volatile: false,
  sourceType: 'session',
  sourceRef: null,
  embeddingPending: false,
  lastAccessedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  validFrom: null,
  validTo: null,
  observedAt: null,
  recordedAt: null,
  ...partial
})

const ALL_CATS = new Set(ALL_CATEGORIES)
const ALL_TIER_SET = new Set<number>(ALL_TIERS)
const ids = (facts: MemoryFact[]): string[] => facts.map((f) => f.id)

describe('scopeFacts', () => {
  const active = fact({ id: 'a', status: 'active' })
  const superseded = fact({ id: 's', status: 'superseded' })
  const archived = fact({ id: 'r', status: 'archived' })
  const all = [active, superseded, archived]

  test('the default view is active facts only', () => {
    assert.deepEqual(ids(scopeFacts(all, 'all')), ['a'])
  })

  test('superseded is the only filter that leaves the active set', () => {
    assert.deepEqual(ids(scopeFacts(all, 'superseded')), ['s'])
  })

  test('archived facts are never shown by any filter', () => {
    for (const status of [
      'all',
      'validated',
      'unvalidated',
      'pending-embedding',
      'superseded'
    ] as const) {
      assert.equal(ids(scopeFacts(all, status)).includes('r'), false, `leaked under ${status}`)
    }
  })

  test('validated means tier ≥ 1 or at least one piece of evidence', () => {
    const byTier = fact({ id: 't1', tier: 1 })
    const byEvidence = fact({ id: 'ev', tier: 0, evidenceCount: 2 })
    const neither = fact({ id: 'no', tier: 0, evidenceCount: 0 })
    const set = [byTier, byEvidence, neither]

    assert.deepEqual(ids(scopeFacts(set, 'validated')).sort(), ['ev', 't1'])
    assert.deepEqual(ids(scopeFacts(set, 'unvalidated')), ['no'])
  })

  test('pending-embedding is scoped to active facts', () => {
    const set = [
      fact({ id: 'p', embeddingPending: true }),
      fact({ id: 'sp', status: 'superseded', embeddingPending: true })
    ]
    assert.deepEqual(ids(scopeFacts(set, 'pending-embedding')), ['p'])
  })
})

describe('counts', () => {
  test('tier counts clamp anything above T3 into T3', () => {
    const counts = countByTier([fact({ tier: 0 }), fact({ tier: 3 }), fact({ tier: 9 as never })])
    assert.deepEqual(counts, { 0: 1, 1: 0, 2: 0, 3: 2 })
  })

  test('every category is present even at zero, so the menu never shifts', () => {
    const counts = countByCategory([fact({ category: 'gotcha' })])
    assert.deepEqual(Object.keys(counts).sort(), [...ALL_CATEGORIES].sort())
    assert.equal(counts.gotcha, 1)
    assert.equal(counts.decision, 0)
  })

  test('validated percentage is zero for an empty set rather than NaN', () => {
    assert.equal(validatedPercent([]), 0)
  })

  test('validated percentage rounds', () => {
    // 1 of 3 validated → 33%
    assert.equal(validatedPercent([fact({ tier: 1 }), fact({ tier: 0 }), fact({ tier: 0 })]), 33)
  })
})

describe('narrowAndSort', () => {
  const base = { categories: ALL_CATS, tiers: ALL_TIER_SET, sort: 'newest' as const, needle: '' }

  test('an unselected category is excluded', () => {
    const set = [fact({ id: 'd', category: 'decision' }), fact({ id: 'g', category: 'gotcha' })]
    const out = narrowAndSort(set, { ...base, categories: new Set(['gotcha' as const]) })
    assert.deepEqual(ids(out), ['g'])
  })

  test('an unselected tier is excluded, with T4+ treated as T3', () => {
    const set = [fact({ id: 'lo', tier: 0 }), fact({ id: 'hi', tier: 9 as never })]
    const out = narrowAndSort(set, { ...base, tiers: new Set([3]) })
    assert.deepEqual(ids(out), ['hi'])
  })

  test('the needle matches title, content and tags, case-insensitively', () => {
    const set = [
      fact({ id: 'byTitle', title: 'Prisma migrations' }),
      fact({ id: 'byContent', title: 'x', content: 'run PRISMA on boot' }),
      fact({ id: 'byTag', title: 'x', content: 'y', tags: ['prisma'] }),
      fact({ id: 'miss', title: 'x', content: 'y' })
    ]
    const out = narrowAndSort(set, { ...base, needle: '  PrIsMa ' })
    assert.deepEqual(ids(out).sort(), ['byContent', 'byTag', 'byTitle'])
  })

  test('an empty needle matches everything', () => {
    const set = [fact({ id: 'a' }), fact({ id: 'b' })]
    assert.equal(narrowAndSort(set, { ...base, needle: '   ' }).length, 2)
  })

  test('newest sorts by createdAt descending', () => {
    const set = [
      fact({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
      fact({ id: 'new', createdAt: '2026-06-01T00:00:00.000Z' })
    ]
    assert.deepEqual(ids(narrowAndSort(set, { ...base, sort: 'newest' })), ['new', 'old'])
  })

  test('tier sort breaks ties on confidence', () => {
    const set = [
      fact({ id: 'lowConf', tier: 2, confidence: 0.4 }),
      fact({ id: 'highConf', tier: 2, confidence: 0.9 }),
      fact({ id: 'top', tier: 3, confidence: 0.1 })
    ]
    assert.deepEqual(ids(narrowAndSort(set, { ...base, sort: 'tier' })), [
      'top',
      'highConf',
      'lowConf'
    ])
  })

  test('confirms sorts by confirmationCount descending', () => {
    const set = [
      fact({ id: 'few', confirmationCount: 1 }),
      fact({ id: 'many', confirmationCount: 9 })
    ]
    assert.deepEqual(ids(narrowAndSort(set, { ...base, sort: 'confirms' })), ['many', 'few'])
  })

  test('the input array is never mutated', () => {
    const set = [
      fact({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z' }),
      fact({ id: 'b', createdAt: '2026-06-01T00:00:00.000Z' })
    ]
    narrowAndSort(set, { ...base, sort: 'newest' })
    assert.deepEqual(ids(set), ['a', 'b'])
  })
})

describe('buildRows', () => {
  test('non-tier sorts produce a flat list with no group headers', () => {
    const rows = buildRows([fact(), fact()], 'newest', new Set())
    assert.equal(rows.length, 2)
    assert.equal(
      rows.every((r) => r.kind === 'fact'),
      true
    )
  })

  test('empty tier groups are dropped entirely', () => {
    const rows = buildRows([fact({ tier: 1 })], 'tier', new Set())
    const groups = rows.filter((r) => r.kind === 'group')
    assert.equal(groups.length, 1)
    assert.equal(groups[0].kind === 'group' && groups[0].tier, 1)
  })

  test('groups are ordered highest tier first', () => {
    const rows = buildRows([fact({ tier: 0 }), fact({ tier: 3 })], 'tier', new Set())
    const tiers = rows
      .filter((r) => r.kind === 'group')
      .map((r) => (r.kind === 'group' ? r.tier : -1))
    assert.deepEqual(tiers, [3, 0])
  })

  test('a collapsed group keeps its header and its count but drops its facts', () => {
    const rows = buildRows([fact({ tier: 2 }), fact({ tier: 2 })], 'tier', new Set([2]))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind === 'group' && rows[0].collapsed, true)
    assert.equal(rows[0].kind === 'group' && rows[0].count, 2)
  })

  test('an empty input produces no rows at all', () => {
    assert.deepEqual(buildRows([], 'tier', new Set()), [])
  })
})

// ── Standalone runner ─────────────────────────────────────────────
// summaryAsync calls process.exit — unguarded it kills the whole suite when
// this file is imported by a runner, taking every later test file with it.
if (process.argv[1]?.includes('facts-model')) {
  void summaryAsync()
}
