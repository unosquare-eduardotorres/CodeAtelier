/**
 * memory-cleanup.repository.test.ts — the deterministic GC primitives.
 *
 * These are the only code paths in the memory system that delete a fact row
 * permanently, so what is pinned here is not CRUD but the guard rails:
 *
 *   - the tombstone sweep is scoped, aged, and cleans up every table that
 *     references the rows it removes (contradictions have no ON DELETE, so an
 *     un-deleted one aborts the whole statement on an FK violation);
 *   - confirmation compaction never touches non-retrieval evidence and leaves
 *     enough markers behind that promotion history is not rewritten;
 *   - archive → restore is exact, including `valid_to`, because an `active`
 *     fact with a closed validity window is invisible to retrieval and that
 *     failure is silent.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { attachTestDb, liveTestDb } from './db-test-helper'

const env = attachTestDb()

let memoryFactRepository: any
let memoryCleanupRunRepository: any
if (env) {
  memoryFactRepository = require('../memory-fact.repository').memoryFactRepository
  memoryCleanupRunRepository =
    require('../memory-cleanup-run.repository').memoryCleanupRunRepository
}

if (!env) {
  describe('memory cleanup (skipped — no DB)', () => {
    test('tombstone GC', () => {}, { skipReason: 'no DB' })
  })
} else {
  const wsId = env.wsId

  /** Insert a fact directly so `valid_to` and ages can be stated exactly. */
  function seedFact(opts: {
    status?: string
    tier?: number
    validToDaysAgo?: number | null
    workspaceId?: string | null
    title?: string
  }): string {
    const db = liveTestDb()
    const validTo =
      opts.validToDaysAgo === undefined || opts.validToDaysAgo === null
        ? null
        : `datetime('now', '-${opts.validToDaysAgo} days')`

    const row = db
      .prepare(
        `INSERT INTO memory_facts
           (workspace_id, category, title, content, tier, status, source_type, valid_to)
         VALUES (?, 'convention', ?, 'content', ?, ?, 'manual', ${validTo ?? 'NULL'})
         RETURNING id`
      )
      .get(
        opts.workspaceId === undefined ? wsId : opts.workspaceId,
        opts.title ?? 'fact',
        opts.tier ?? 0,
        opts.status ?? 'active'
      ) as { id: string }
    return row.id
  }

  function addConfirmation(factId: string, sourceType: string, daysAgo: number): void {
    liveTestDb()
      .prepare(
        `INSERT INTO memory_confirmations (fact_id, source_type, weight, created_at)
         VALUES (?, ?, 1.0, datetime('now', '-${daysAgo} days'))`
      )
      .run(factId, sourceType)
  }

  function countRows(sql: string, ...params: unknown[]): number {
    const row = liveTestDb().prepare(sql).get(...params) as { n: number }
    return row.n
  }

  // ── Tombstone GC ────────────────────────────────────────────────────────

  describe('hardDeleteTombstones', () => {
    test('removes aged tombstones and everything referencing them', () => {
      const dead = seedFact({ status: 'archived', validToDaysAgo: 120, title: 'dead' })
      const alive = seedFact({ title: 'alive' })

      addConfirmation(dead, 'extraction', 200)
      memoryFactRepository.createEdge({ fromId: alive, toId: dead, edgeType: 'supersedes' })
      memoryFactRepository.createContradiction({
        oldFactId: dead,
        newFactId: alive,
        status: 'pending',
        resolution: 'test'
      })

      const result = memoryFactRepository.hardDeleteTombstones(wsId, 90)

      assert.equal(result.facts, 1, 'one tombstone deleted')
      assert.ok(result.contradictions >= 1, 'its contradiction row went with it')
      assert.ok(result.edges >= 1, 'its edge went with it')

      assert.equal(
        countRows('SELECT COUNT(*) AS n FROM memory_facts WHERE id = ?', dead),
        0,
        'tombstone row is gone'
      )
      assert.equal(
        countRows('SELECT COUNT(*) AS n FROM memory_facts WHERE id = ?', alive),
        1,
        'the active fact it pointed at survives'
      )
      assert.equal(
        countRows('SELECT COUNT(*) AS n FROM memory_confirmations WHERE fact_id = ?', dead),
        0,
        'confirmations cascade'
      )
      assert.equal(
        countRows(
          'SELECT COUNT(*) AS n FROM memory_edges WHERE from_id = ? OR to_id = ?',
          dead,
          dead
        ),
        0,
        'edges are gone'
      )
    })

    test('leaves tombstones inside the TTL alone', () => {
      const recent = seedFact({ status: 'archived', validToDaysAgo: 10, title: 'recent' })
      memoryFactRepository.hardDeleteTombstones(wsId, 90)
      assert.equal(countRows('SELECT COUNT(*) AS n FROM memory_facts WHERE id = ?', recent), 1)
    })

    test('never touches active facts, however old', () => {
      const active = seedFact({ validToDaysAgo: null, title: 'still-true' })
      liveTestDb()
        .prepare(`UPDATE memory_facts SET created_at = datetime('now','-900 days') WHERE id = ?`)
        .run(active)
      memoryFactRepository.hardDeleteTombstones(wsId, 90)
      assert.equal(countRows('SELECT COUNT(*) AS n FROM memory_facts WHERE id = ?', active), 1)
    })

    test('never deletes global facts — they belong to every workspace', () => {
      const global = seedFact({
        status: 'archived',
        validToDaysAgo: 500,
        workspaceId: null,
        title: 'global'
      })
      memoryFactRepository.hardDeleteTombstones(wsId, 90)
      assert.equal(
        countRows('SELECT COUNT(*) AS n FROM memory_facts WHERE id = ?', global),
        1,
        'a sweep in one workspace must not retire a shared fact'
      )
      liveTestDb().prepare('DELETE FROM memory_facts WHERE id = ?').run(global)
    })

    test('countTombstones agrees with what the delete actually removes', () => {
      const ids = [
        seedFact({ status: 'archived', validToDaysAgo: 200, title: 'c1' }),
        seedFact({ status: 'superseded', validToDaysAgo: 300, title: 'c2' })
      ]
      const predicted = memoryFactRepository.countTombstones(wsId, 90)
      const actual = memoryFactRepository.hardDeleteTombstones(wsId, 90).facts
      assert.equal(predicted, actual, 'a preview that disagrees with apply is worthless')
      assert.equal(actual, ids.length)
    })
  })

  // ── Confirmation log compaction ─────────────────────────────────────────

  describe('pruneRetrievalConfirmations', () => {
    test('keeps one retrieval marker per month and never prunes real evidence', () => {
      const fact = seedFact({ title: 'busy' })

      // Two old months of daily retrieval, plus irreplaceable evidence.
      for (const day of [400, 399, 398, 397, 370, 369, 368]) {
        addConfirmation(fact, 'retrieval', day)
      }
      addConfirmation(fact, 'human', 395)
      addConfirmation(fact, 'extraction', 380)
      // Inside the TTL — must survive untouched.
      addConfirmation(fact, 'retrieval', 5)

      const predicted = memoryFactRepository.countPrunableRetrievalConfirmations(180)
      const deleted = memoryFactRepository.pruneRetrievalConfirmations(180)
      assert.equal(predicted, deleted, 'count and delete share one predicate')
      assert.ok(deleted > 0, 'something was actually compacted')

      assert.equal(
        countRows(
          `SELECT COUNT(*) AS n FROM memory_confirmations
           WHERE fact_id = ? AND source_type IN ('human','extraction')`,
          fact
        ),
        2,
        'non-retrieval evidence is never pruned at any age'
      )
      assert.equal(
        countRows(
          `SELECT COUNT(*) AS n FROM memory_confirmations
           WHERE fact_id = ? AND source_type = 'retrieval'
             AND julianday('now') - julianday(created_at) <= 180`,
          fact
        ),
        1,
        'recent retrievals are untouched'
      )

      // The point of keeping a marker: the fact must still look long-used.
      const months = countRows(
        `SELECT COUNT(DISTINCT strftime('%Y-%m', created_at)) AS n
         FROM memory_confirmations
         WHERE fact_id = ? AND source_type = 'retrieval'
           AND julianday('now') - julianday(created_at) > 180`,
        fact
      )
      assert.equal(months, 2, 'both historical months still have a marker')

      assert.ok(
        memoryFactRepository.countConfirmationDays(fact) >= 4,
        'distinct-day history survives compaction, so promotion is not reset'
      )
    })
  })

  // ── Archive / restore ───────────────────────────────────────────────────

  describe('archiveFacts / restoreFacts', () => {
    test('archiving closes the validity window; restoring reopens it exactly', () => {
      const fact = seedFact({ tier: 1, title: 'round-trip' })
      const before = memoryFactRepository.findById(fact)
      assert.equal(before.status, 'active')
      assert.equal(before.validTo, null)

      assert.equal(memoryFactRepository.archiveFacts([fact]), 1)

      const archived = memoryFactRepository.findById(fact)
      assert.equal(archived.status, 'archived')
      assert.ok(archived.validTo, 'archiving closes the window')

      memoryFactRepository.restoreFacts([
        { id: fact, prevStatus: 'active', prevTier: 1, prevValidTo: null }
      ])

      const restored = memoryFactRepository.findById(fact)
      assert.equal(restored.status, 'active')
      assert.equal(restored.tier, 1)
      assert.equal(
        restored.validTo,
        null,
        'an active fact with a closed window would never be retrieved again'
      )
    })

    test('archiveFacts skips facts that are not active', () => {
      const already = seedFact({ status: 'archived', validToDaysAgo: 1, title: 'already' })
      assert.equal(memoryFactRepository.archiveFacts([already]), 0)
    })
  })

  // ── Undo log ────────────────────────────────────────────────────────────

  describe('memoryCleanupRunRepository', () => {
    const stats = {
      idleArchived: 3,
      curatorArchived: 0,
      curatorMerged: 0,
      curatorCalls: 0,
      tombstonesDeleted: 7,
      edgesDeleted: 1,
      contradictionsDeleted: 0,
      confirmationsPruned: 12
    }

    test('an applied run with undo entries is reversible exactly once', () => {
      const run = memoryCleanupRunRepository.create({
        workspaceId: wsId,
        mode: 'apply',
        trigger: 'manual',
        stats,
        undo: [{ id: 'f1', prevStatus: 'active', prevTier: 0, prevValidTo: null }]
      })

      assert.equal(run.undoableCount, 1)
      assert.equal(run.stats.tombstonesDeleted, 7)

      const undoable = memoryCleanupRunRepository.findUndoable(wsId, 7)
      assert.equal(undoable?.id, run.id)
      assert.equal(memoryCleanupRunRepository.getUndoEntries(run.id).length, 1)

      assert.equal(memoryCleanupRunRepository.markUndone(run.id), true)
      assert.equal(
        memoryCleanupRunRepository.markUndone(run.id),
        false,
        'a second undo press must not re-apply the restore'
      )
      assert.equal(
        memoryCleanupRunRepository.getUndoEntries(run.id).length,
        0,
        'the log is cleared with the same statement that claims the run'
      )
    })

    test('runs with an empty undo log are never offered as undoable', () => {
      const run = memoryCleanupRunRepository.create({
        workspaceId: wsId,
        mode: 'apply',
        trigger: 'idle',
        stats,
        undo: []
      })
      const undoable = memoryCleanupRunRepository.findUndoable(wsId, 7)
      assert.notEqual(undoable?.id, run.id)
    })

    test('preview runs are never undoable', () => {
      memoryCleanupRunRepository.create({
        workspaceId: wsId,
        mode: 'preview',
        trigger: 'manual',
        stats,
        undo: [{ id: 'f9', prevStatus: 'active', prevTier: 0, prevValidTo: null }]
      })
      const undoable = memoryCleanupRunRepository.findUndoable(wsId, 7)
      assert.ok(!undoable || undoable.mode === 'apply')
    })
  })
}

// Standalone runner
if (process.argv[1]?.includes('memory-cleanup.repository')) {
  const { passed, failed, skipped } = require('../../../services/__tests__/test-harness')
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exit(failed > 0 ? 1 : 0)
}
