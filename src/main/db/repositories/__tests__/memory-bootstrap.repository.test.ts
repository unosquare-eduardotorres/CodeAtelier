/**
 * Tests for MemoryBootstrapRepository — the durable Feed Brain job queue
 * (migration 133). Covers run/item CRUD, atomic claiming, chunk-level
 * progress, derived counters and crash recovery.
 *
 * Skips gracefully if the better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'
import type { PlannedItem } from '../memory-bootstrap.repository'

const env = trySetupTestDb()

if (!env) {
  describe('MemoryBootstrapRepository (skipped — native module unavailable)', () => {
    test('queue round-trip', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { memoryBootstrapRepository: repo } = require('../memory-bootstrap.repository')

  const plan = (runId: string, items: PlannedItem[]): number => repo.planItems(runId, wsId, items)

  const newRun = (mode = 'full', scope = 'changed'): string =>
    repo.createRun({ workspaceId: wsId, mode, scope })

  // ── Migration ──────────────────────────────────────────────────────────

  describe('migration 133', () => {
    test('creates both queue tables', () => {
      const names = env.db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('memory_bootstrap_runs','memory_bootstrap_items')`
        )
        .all() as Array<{ name: string }>
      const tableNames = names.map((r) => r.name).sort()
      assert.deepEqual(tableNames, ['memory_bootstrap_items', 'memory_bootstrap_runs'])
    })
  })

  // ── Runs ───────────────────────────────────────────────────────────────

  describe('MemoryBootstrapRepository runs', () => {
    test('createRun starts in planning with zeroed counters', () => {
      const runId = newRun()
      const run = repo.getRun(runId)

      assert.ok(run, 'run should exist')
      assert.equal(run.status, 'planning')
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.mode, 'full')
      assert.equal(run.scope, 'changed')
      assert.equal(run.itemsTotal, 0)
      assert.equal(run.factsCreated, 0)
      assert.equal(run.finishedAt, null)
    })

    test('updateRun applies a partial patch without clobbering other columns', () => {
      const runId = newRun()
      repo.updateRun(runId, { itemsTotal: 12, activeMs: 4200 })
      repo.updateRun(runId, { status: 'running' })

      const run = repo.getRun(runId)
      assert.equal(run.status, 'running')
      assert.equal(run.itemsTotal, 12, 'earlier patch must survive')
      assert.equal(run.activeMs, 4200)
    })

    test('listRuns is workspace-scoped and newest-first', () => {
      const runId = newRun()
      const runs = repo.listRuns(wsId, 5)
      assert.ok(runs.length > 0)
      assert.equal(runs[0].id, runId, 'most recent run comes first')
      assert.ok(runs.every((r: { workspaceId: string }) => r.workspaceId === wsId))
    })

    test('getRun returns undefined for an unknown id', () => {
      assert.equal(repo.getRun('does-not-exist'), undefined)
    })
  })

  // ── Planning + claiming ────────────────────────────────────────────────

  describe('MemoryBootstrapRepository planning', () => {
    test('planItems inserts every item and returns the count', () => {
      const runId = newRun()
      const count = plan(runId, [
        { phase: 'stack', kind: 'manifests', sourceRef: 'project-manifests', priority: 0 },
        { phase: 'docs', kind: 'doc', sourceRef: 'README.md', priority: 1010 },
        { phase: 'docs', kind: 'doc', sourceRef: 'docs/guide.md', priority: 1050 }
      ])

      assert.equal(count, 3)
      assert.equal(repo.listItems(runId).total, 3)
      assert.equal(repo.countPending(runId), 3)
    })

    test('planItems with an empty list is a no-op', () => {
      const runId = newRun()
      assert.equal(plan(runId, []), 0)
      assert.equal(repo.listItems(runId).total, 0)
    })

    test('claimNextItem hands out items in priority order and marks them running', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'scattered.md', priority: 1100 },
        { phase: 'stack', kind: 'manifests', sourceRef: 'project-manifests', priority: 0 },
        { phase: 'docs', kind: 'doc', sourceRef: 'README.md', priority: 1010 }
      ])

      const first = repo.claimNextItem(runId)
      assert.equal(first.sourceRef, 'project-manifests', 'lowest priority number drains first')
      assert.equal(first.status, 'running')

      const second = repo.claimNextItem(runId)
      assert.equal(second.sourceRef, 'README.md')

      const third = repo.claimNextItem(runId)
      assert.equal(third.sourceRef, 'scattered.md')

      assert.equal(repo.claimNextItem(runId), undefined, 'queue is drained')
    })

    test('peekNextItemKind reports the next kind without claiming it', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'agent-exploration', kind: 'agent', sourceRef: 'agent:deep-scan' }])

      assert.equal(repo.peekNextItemKind(runId), 'agent')
      assert.equal(repo.countPending(runId), 1, 'peek must not claim')
      assert.equal(repo.peekNextItemKind('unknown-run'), undefined)
    })

    test('releaseItem returns a claimed item to the queue', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'docs', kind: 'doc', sourceRef: 'README.md' }])

      const item = repo.claimNextItem(runId)
      repo.releaseItem(item.id)

      const reclaimed = repo.claimNextItem(runId)
      assert.equal(reclaimed.id, item.id, 'released item is claimable again')
    })
  })

  // ── Item progress ──────────────────────────────────────────────────────

  describe('MemoryBootstrapRepository item progress', () => {
    test('bumpChunkDone persists partial progress so resume can continue mid-file', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'docs', kind: 'doc', sourceRef: 'BIG.md', chunkTotal: 10 }])
      const item = repo.claimNextItem(runId)

      repo.bumpChunkDone(item.id, 4, 7)
      const { items } = repo.listItems(runId)

      assert.equal(items[0].chunkDone, 4)
      assert.equal(items[0].factsCreated, 7)
      assert.equal(items[0].status, 'running', 'chunk progress does not settle the item')
    })

    test('updateItem records terminal status and error text', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'docs', kind: 'doc', sourceRef: 'BROKEN.md' }])
      const item = repo.claimNextItem(runId)

      repo.updateItem(item.id, { status: 'failed', error: '2/5 chunks failed', factsCreated: 1 })
      const { items } = repo.listItems(runId)

      assert.equal(items[0].status, 'failed')
      assert.equal(items[0].error, '2/5 chunks failed')
      assert.equal(items[0].factsCreated, 1)
    })

    test('syncRunCounters derives run totals from item rows', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'b.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'c.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'd.md' }
      ])

      const a = repo.claimNextItem(runId)
      const b = repo.claimNextItem(runId)
      const c = repo.claimNextItem(runId)
      repo.updateItem(a.id, { status: 'done', factsCreated: 3 })
      repo.updateItem(b.id, { status: 'skipped' })
      repo.updateItem(c.id, { status: 'failed', factsCreated: 1 })

      repo.syncRunCounters(runId)
      const run = repo.getRun(runId)

      assert.equal(run.itemsDone, 1)
      assert.equal(run.itemsSkipped, 1)
      assert.equal(run.itemsFailed, 1)
      assert.equal(run.factsCreated, 4, 'facts sum across every item')
      assert.equal(repo.countPending(runId), 1, 'the untouched item is still pending')
    })

    test('per-phase rollup counts done and skipped as settled', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'b.md' },
        { phase: 'history', kind: 'commits', sourceRef: 'git:recent-commits' }
      ])

      const a = repo.claimNextItem(runId)
      repo.updateItem(a.id, { status: 'done', factsCreated: 5 })

      const run = repo.getRun(runId)
      assert.equal(run.perPhase.docs.total, 2)
      assert.equal(run.perPhase.docs.done, 1)
      assert.equal(run.perPhase.docs.facts, 5)
      assert.equal(run.perPhase.history.total, 1)
      assert.equal(run.perPhase.history.done, 0)
    })
  })

  // ── Listing ────────────────────────────────────────────────────────────

  describe('MemoryBootstrapRepository listItems', () => {
    test('filters by status and reports the filtered total', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'b.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'c.md' }
      ])
      const a = repo.claimNextItem(runId)
      repo.updateItem(a.id, { status: 'done' })

      const done = repo.listItems(runId, { status: 'done' })
      assert.equal(done.total, 1)
      assert.equal(done.items[0].sourceRef, 'a.md')

      const pending = repo.listItems(runId, { status: 'pending' })
      assert.equal(pending.total, 2)
    })

    test('filters by phase', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md' },
        { phase: 'history', kind: 'commits', sourceRef: 'git:recent-commits' }
      ])

      const docs = repo.listItems(runId, { phase: 'docs' })
      assert.equal(docs.total, 1)
      assert.equal(docs.items[0].phase, 'docs')
    })

    test('honours limit and offset', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md', priority: 1 },
        { phase: 'docs', kind: 'doc', sourceRef: 'b.md', priority: 2 },
        { phase: 'docs', kind: 'doc', sourceRef: 'c.md', priority: 3 }
      ])

      const page = repo.listItems(runId, { limit: 2, offset: 1 })
      assert.equal(page.total, 3, 'total ignores paging')
      assert.equal(page.items.length, 2)
    })

    test('surfaces running items before settled ones', () => {
      const runId = newRun()
      plan(runId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'first.md', priority: 1 },
        { phase: 'docs', kind: 'doc', sourceRef: 'second.md', priority: 2 }
      ])
      const first = repo.claimNextItem(runId)
      repo.updateItem(first.id, { status: 'done' })
      repo.claimNextItem(runId) // second stays 'running'

      const { items } = repo.listItems(runId)
      assert.equal(items[0].sourceRef, 'second.md', 'the running item sorts first')
    })
  })

  // ── Resume + recovery ──────────────────────────────────────────────────

  describe('MemoryBootstrapRepository recovery', () => {
    test('markOrphanedRunsPaused demotes running rows and requeues their items', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'docs', kind: 'doc', sourceRef: 'orphan.md', chunkTotal: 8 }])
      repo.updateRun(runId, { status: 'running' })
      const item = repo.claimNextItem(runId)
      repo.bumpChunkDone(item.id, 3, 2)

      repo.markOrphanedRunsPaused()

      const run = repo.getRun(runId)
      assert.equal(run.status, 'paused', 'a zombie run becomes resumable, not stuck')

      const { items } = repo.listItems(runId)
      assert.equal(items[0].status, 'pending', 'the in-flight item is requeued')
      assert.equal(items[0].chunkDone, 3, 'chunk offset survives so resume continues mid-file')
      assert.equal(items[0].factsCreated, 2, 'already-extracted facts are not forgotten')
    })

    test('findResumableRuns returns paused runs and skips completed ones', () => {
      const paused = newRun()
      repo.updateRun(paused, { status: 'paused' })
      const completed = newRun()
      repo.updateRun(completed, { status: 'completed' })

      const ids = repo.findResumableRuns(wsId).map((r: { id: string }) => r.id)
      assert.ok(ids.includes(paused), 'paused run is resumable')
      assert.ok(!ids.includes(completed), 'completed run is not resumable')
    })

    test('deleteRun cascades to its items', () => {
      const runId = newRun()
      plan(runId, [{ phase: 'docs', kind: 'doc', sourceRef: 'a.md' }])

      assert.equal(repo.deleteRun(runId), 1)
      assert.equal(repo.getRun(runId), undefined)
      assert.equal(repo.listItems(runId).total, 0, 'items go with the run')
    })
  })
}
