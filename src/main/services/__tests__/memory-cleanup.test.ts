/**
 * memory-cleanup.test.ts — the rules that decide what gets removed.
 *
 * Everything here is pure, and that is the point: the predicates below are the
 * difference between a janitor and a shredder, so they are tested on stated
 * inputs rather than through a database.
 *
 * Three properties are load-bearing:
 *   1. The idle rule fires on facts that were used *once, long ago* — the bug
 *      that made the old `!lastAccessedAt` rule archive almost nothing.
 *   2. Its protections (tier 2+, human confirmation, volatile, other/global
 *      workspaces, recently created) hold unconditionally.
 *   3. The curator can never act on a fact it was not shown, and a reply that
 *      would wipe a whole batch is discarded rather than partially applied.
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-06-01T00:00:00.000Z')

/** ISO timestamp `n` days before the frozen `NOW`. */
function daysAgo(n: number): string {
  return new Date(NOW - n * DAY).toISOString()
}

function makeFact(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'f1',
    workspaceId: 'ws-1',
    category: 'convention',
    title: 'a fact',
    content: 'body',
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
    sourceType: 'manual',
    sourceRef: null,
    embeddingPending: false,
    lastAccessedAt: null,
    createdAt: daysAgo(400),
    updatedAt: daysAgo(400),
    validFrom: daysAgo(400),
    validTo: null,
    observedAt: daysAgo(400),
    recordedAt: daysAgo(400),
    ...overrides
  }
}

function ctx(overrides: Record<string, unknown> = {}): any {
  return { workspaceId: 'ws-1', idleDays: 90, humanConfirmed: new Set<string>(), now: NOW, ...overrides }
}

// ── The idle-archival rule ──────────────────────────────────────────────────

test('isIdleArchivable: archives a fact used once, long ago', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  const fact = makeFact({ lastAccessedAt: daysAgo(200) })
  assert.equal(
    isIdleArchivable(fact, ctx()),
    true,
    'the old rule exempted any fact ever accessed — this is the bug being fixed'
  )
})

test('isIdleArchivable: protects a fact accessed inside the window', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  assert.equal(isIdleArchivable(makeFact({ lastAccessedAt: daysAgo(10) }), ctx()), false)
})

test('isIdleArchivable: boundary — exactly idleDays is protected, one more is not', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  assert.equal(
    isIdleArchivable(makeFact({ lastAccessedAt: daysAgo(90) }), ctx()),
    false,
    '90 days idle is not yet "over 90 days"'
  )
  assert.equal(isIdleArchivable(makeFact({ lastAccessedAt: daysAgo(91) }), ctx()), true)
})

test('isIdleArchivable: falls back through lastConfirmedAt to createdAt', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  assert.equal(
    isIdleArchivable(makeFact({ lastAccessedAt: null, lastConfirmedAt: daysAgo(5) }), ctx()),
    false,
    'a recently re-confirmed fact is in use even if never retrieved'
  )
  assert.equal(
    isIdleArchivable(makeFact({ lastAccessedAt: null, lastConfirmedAt: null }), ctx()),
    true,
    'never touched at all, created 400 days ago'
  )
})

test('isIdleArchivable: tier 2+ is never archived', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  for (const tier of [2, 3]) {
    assert.equal(
      isIdleArchivable(makeFact({ tier }), ctx()),
      false,
      `T${tier} is established knowledge — idleness is not evidence against it`
    )
  }
  for (const tier of [0, 1]) {
    assert.equal(isIdleArchivable(makeFact({ tier }), ctx()), true)
  }
})

test('isIdleArchivable: a human confirmation is an absolute veto', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  const fact = makeFact({ id: 'vouched' })
  assert.equal(isIdleArchivable(fact, ctx({ humanConfirmed: new Set(['vouched']) })), false)
})

test('isIdleArchivable: volatile facts are pinned', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  assert.equal(isIdleArchivable(makeFact({ volatile: true }), ctx()), false)
})

test('isIdleArchivable: global and foreign-workspace facts are out of scope', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  assert.equal(
    isIdleArchivable(makeFact({ workspaceId: null }), ctx()),
    false,
    'a global fact belongs to every workspace'
  )
  assert.equal(isIdleArchivable(makeFact({ workspaceId: 'ws-other' }), ctx()), false)
})

test('isIdleArchivable: only active facts are candidates', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  for (const status of ['archived', 'superseded']) {
    assert.equal(isIdleArchivable(makeFact({ status }), ctx()), false)
  }
})

test('isIdleArchivable: a fact created inside the window is protected regardless', async () => {
  const { isIdleArchivable } = await import('../memory-cleanup.service')
  const fresh = makeFact({ createdAt: daysAgo(3), lastConfirmedAt: daysAgo(300) })
  assert.equal(
    isIdleArchivable(fresh, ctx()),
    false,
    'an imported fact with a stale confirmation must get a chance to be used'
  )
})

test('selectIdleArchivalCandidates: filters a mixed corpus', async () => {
  const { selectIdleArchivalCandidates } = await import('../memory-cleanup.service')
  const facts = [
    makeFact({ id: 'idle-1', lastAccessedAt: daysAgo(200) }),
    makeFact({ id: 'idle-2', lastAccessedAt: null }),
    makeFact({ id: 'fresh', lastAccessedAt: daysAgo(2) }),
    makeFact({ id: 'established', tier: 2 }),
    makeFact({ id: 'vouched' }),
    makeFact({ id: 'pinned', volatile: true }),
    makeFact({ id: 'global', workspaceId: null })
  ]
  const selected = selectIdleArchivalCandidates(
    facts,
    ctx({ humanConfirmed: new Set(['vouched']) })
  )
  assert.deepEqual(
    selected.map((f: any) => f.id),
    ['idle-1', 'idle-2']
  )
})

// ── Review queue fairness ───────────────────────────────────────────────────

test('selectReviewQueueVictims: discards the least similar first, not the oldest', async () => {
  const { selectReviewQueueVictims } = await import('../memory-consolidation.service')
  const pending = [
    { id: 'new-weak', resolution: 'review cluster (2 facts, best cosine: 0.860)', createdAt: daysAgo(1) },
    { id: 'old-strong', resolution: 'review cluster (2 facts, best cosine: 0.949)', createdAt: daysAgo(90) }
  ]
  const victims = selectReviewQueueVictims(pending, 1)
  assert.deepEqual(
    victims.map((v: any) => v.id),
    ['new-weak'],
    'a barely-similar pair is the cheapest thing to lose, whatever its age'
  )
})

test('selectReviewQueueVictims: unscored items survive while scored ones exist', async () => {
  const { selectReviewQueueVictims } = await import('../memory-consolidation.service')
  const pending = [
    { id: 'unscored', resolution: 'manual contradiction', createdAt: daysAgo(300) },
    { id: 'scored', resolution: 'duplicate cluster (2 facts, cosine: 0.910)', createdAt: daysAgo(1) }
  ]
  assert.deepEqual(
    selectReviewQueueVictims(pending, 1).map((v: any) => v.id),
    ['scored'],
    'we cannot judge an unscored pair, so it is not the one to throw away'
  )
})

test('selectReviewQueueVictims: returns nothing when the queue is under cap', async () => {
  const { selectReviewQueueVictims } = await import('../memory-consolidation.service')
  const pending = [{ id: 'a', resolution: null, createdAt: daysAgo(1) }]
  assert.deepEqual(selectReviewQueueVictims(pending, 0), [])
  assert.deepEqual(selectReviewQueueVictims(pending, -3), [])
})

test('parseReviewSimilarity: reads the cosine, or scores unparseable as protected', async () => {
  const { parseReviewSimilarity } = await import('../memory-consolidation.service')
  assert.equal(parseReviewSimilarity('review cluster (3 facts, best cosine: 0.873)'), 0.873)
  assert.equal(parseReviewSimilarity('duplicate cluster (2 facts, cosine: 0.951)'), 0.951)
  assert.equal(parseReviewSimilarity(null), Number.POSITIVE_INFINITY)
  assert.equal(parseReviewSimilarity('no numbers here'), Number.POSITIVE_INFINITY)
})

// ── Curator safety ──────────────────────────────────────────────────────────

test('parseVerdicts: drops verdicts naming a fact that was not in the batch', async () => {
  const { parseVerdicts } = await import('../memory-curator.service')
  const allowed = new Set(['a', 'b', 'c'])
  const reply = JSON.stringify([
    { id: 'a', verdict: 'KEEP', reason: 'distinct' },
    { id: 'ghost', verdict: 'ARCHIVE', reason: 'hallucinated id' }
  ])
  const verdicts = parseVerdicts(reply, allowed)
  assert.deepEqual(
    verdicts.map((v: any) => v.id),
    ['a'],
    'a model must not be able to reach a fact it was never shown'
  )
})

test('parseVerdicts: rejects a merge whose target is outside the batch or is itself', async () => {
  const { parseVerdicts } = await import('../memory-curator.service')
  const allowed = new Set(['a', 'b'])
  const reply = JSON.stringify([
    { id: 'a', verdict: 'MERGE_INTO', target: 'elsewhere', reason: 'x' },
    { id: 'b', verdict: 'MERGE_INTO', target: 'b', reason: 'y' }
  ])
  assert.deepEqual(parseVerdicts(reply, allowed), [])
})

test('parseVerdicts: discards a reply that would archive the whole batch', async () => {
  const { parseVerdicts } = await import('../memory-curator.service')
  const allowed = new Set(['a', 'b'])
  const reply = JSON.stringify([
    { id: 'a', verdict: 'ARCHIVE', reason: 'dupe' },
    { id: 'b', verdict: 'ARCHIVE', reason: 'dupe' }
  ])
  assert.deepEqual(
    parseVerdicts(reply, allowed),
    [],
    'losing every fact in a cluster is the shape of a model that lost the plot'
  )
})

test('parseVerdicts: accepts a well-formed mixed reply, ignoring fences and prose', async () => {
  const { parseVerdicts } = await import('../memory-curator.service')
  const allowed = new Set(['a', 'b', 'c'])
  const reply = [
    'Here is my assessment:',
    '```json',
    JSON.stringify([
      { id: 'a', verdict: 'KEEP', reason: 'distinct rule' },
      { id: 'b', verdict: 'MERGE_INTO', target: 'a', reason: 'same rule, less complete' },
      { id: 'c', verdict: 'ARCHIVE', reason: 'obsolete' }
    ]),
    '```'
  ].join('\n')

  const verdicts = parseVerdicts(reply, allowed)
  assert.equal(verdicts.length, 3)
  assert.equal(verdicts[1].verdict, 'MERGE_INTO')
  assert.equal(verdicts[1].target, 'a')
  assert.equal(verdicts[2].verdict, 'ARCHIVE')
})

test('parseVerdicts: returns nothing for unusable output', async () => {
  const { parseVerdicts } = await import('../memory-curator.service')
  const allowed = new Set(['a'])
  assert.deepEqual(parseVerdicts('', allowed), [])
  assert.deepEqual(parseVerdicts('no json at all', allowed), [])
  assert.deepEqual(parseVerdicts('[not valid json', allowed), [])
})

test('isCuratable: mirrors the idle rule protections', async () => {
  const { isCuratable } = await import('../memory-curator.service')
  assert.equal(isCuratable(makeFact({ id: 'ok' }), 'ws-1'), true)
  assert.equal(isCuratable(makeFact({ id: 'x', tier: 2 }), 'ws-1'), false)
  assert.equal(isCuratable(makeFact({ id: 'x', volatile: true }), 'ws-1'), false)
  assert.equal(isCuratable(makeFact({ id: 'x', status: 'archived' }), 'ws-1'), false)
  assert.equal(isCuratable(makeFact({ id: 'x', workspaceId: null }), 'ws-1'), false)
  assert.equal(isCuratable(makeFact({ id: 'v' }), 'ws-1', new Set(['v'])), false)
})

test('batchClusters: never splits a cluster across two model calls', async () => {
  const { batchClusters } = await import('../memory-curator.service')
  const cluster = (n: number, prefix: string): any[] =>
    Array.from({ length: n }, (_, i) => makeFact({ id: `${prefix}${i}` }))

  const batches = batchClusters([cluster(3, 'a'), cluster(3, 'b'), cluster(2, 'c')], 5)
  assert.equal(batches.length, 2)
  assert.deepEqual(
    batches[0].map((f: any) => f.id),
    ['a0', 'a1', 'a2']
  )
  assert.equal(batches[1].length, 5, 'b and c fit together')
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
