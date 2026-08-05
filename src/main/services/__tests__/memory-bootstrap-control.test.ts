/**
 * Tests for the Feed Brain control surface — pause / resume / cancel, snapshot
 * re-attachment, and crash recovery.
 *
 * These are the behaviours the old service simply did not have: it only knew
 * how to abort, and everything lived in memory, so quitting the app discarded
 * an in-flight run entirely.
 */

import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// The service module is required lazily so a DB failure degrades to skips
// rather than blowing up the whole suite at import time.
let svc: any
let repo: any
let wsId: string | null = null
let dbReady = false

try {
  process.env.NODE_ENV = 'test'
  const { createTestDb, seedWorkspace } = require('../../db/test-helpers')
  const { _setDatabaseForTesting } = require('../../db/index')
  const db = createTestDb()
  _setDatabaseForTesting(db)
  wsId = seedWorkspace(db)
  repo = require('../../db/repositories/memory-bootstrap.repository').memoryBootstrapRepository

  // Load a private instance of the service. In the shared runner an earlier
  // file may already have cached memory-bootstrap.service while setup-full-mock
  // had Module._load patched, in which case its `memoryBootstrapRepository`
  // binding is the mock (which has no queue methods at all). Re-requiring it
  // with the real repository already cached guarantees a matching identity;
  // the original cache entry is restored so later files are unaffected.
  // Same pattern as memory-bootstrap-doc-state.test.ts.
  const svcPath = require.resolve('../memory-bootstrap.service')
  const previous = require.cache[svcPath]
  delete require.cache[svcPath]
  svc = require(svcPath).memoryBootstrapService
  if (previous) require.cache[svcPath] = previous
  else delete require.cache[svcPath]

  dbReady = true
} catch (err) {
  console.log(`\n⚠ Bootstrap control test setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message.split('\n')[0]})`)
}

if (!dbReady) {
  describe('MemoryBootstrapService control (skipped — DB unavailable)', () => {
    test('pause/resume/cancel', () => {}, { skipReason: 'no DB' })
  })
} else {
  const newRun = (status = 'paused'): string => {
    const runId = repo.createRun({ workspaceId: wsId, mode: 'full', scope: 'changed' })
    repo.updateRun(runId, { status })
    return runId
  }

  // ── Idle behaviour ─────────────────────────────────────────────────────

  describe('MemoryBootstrapService when idle', () => {
    test('isRunning is false with no active run', () => {
      assert.equal(svc.isRunning, false)
    })

    test('isRunningFor is false for an unknown workspace', () => {
      assert.equal(svc.isRunningFor('ws-does-not-exist'), false)
    })

    test('cancel returns false for an unknown job', () => {
      assert.equal(svc.cancel('nonexistent-job'), false)
    })

    test('pause returns false when nothing is running', () => {
      assert.equal(svc.pause(wsId), false, 'pausing an idle workspace is a no-op, not an error')
    })

    test('cancelAll is safe when no jobs are running', () => {
      svc.cancelAll()
      assert.equal(svc.isRunning, false)
    })
  })

  // ── Snapshot ───────────────────────────────────────────────────────────

  describe('MemoryBootstrapService.getSnapshot', () => {
    test('reports no run for a workspace that has never ingested', () => {
      const snap = svc.getSnapshot('ws-never-used')
      assert.equal(snap.latestRun, null)
      assert.equal(snap.resumableRunId, null)
      assert.equal(snap.progress, null)
    })

    test('returns the most recent run so the page can re-attach after navigation', () => {
      const runId = newRun('completed')
      const snap = svc.getSnapshot(wsId)

      assert.ok(snap.latestRun, 'a completed run is still reported')
      assert.equal(snap.latestRun.id, runId)
      assert.equal(snap.latestRun.status, 'completed')
    })

    test('offers a resumable run only when items are actually left', () => {
      const emptyPaused = newRun('paused')
      assert.equal(
        svc.getSnapshot(wsId).resumableRunId,
        null,
        'a paused run with an empty queue is not worth resuming'
      )

      repo.planItems(emptyPaused, wsId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'README.md' }
      ])
      assert.equal(
        svc.getSnapshot(wsId).resumableRunId,
        emptyPaused,
        'a paused run with pending items is resumable'
      )
    })

    test('does not offer a completed run as resumable', () => {
      const runId = newRun('completed')
      repo.planItems(runId, wsId, [{ phase: 'docs', kind: 'doc', sourceRef: 'A.md' }])

      const snap = svc.getSnapshot(wsId)
      assert.notEqual(snap.resumableRunId, runId)
    })
  })

  // ── Listing ────────────────────────────────────────────────────────────

  describe('MemoryBootstrapService listing', () => {
    test('listRuns is workspace-scoped', () => {
      newRun('completed')
      const runs = svc.listRuns(wsId, 5)

      assert.ok(runs.length > 0)
      assert.ok(runs.every((r: { workspaceId: string }) => r.workspaceId === wsId))
      assert.equal(svc.listRuns('ws-other').length, 0)
    })

    test('listItems exposes per-document rows for the UI', () => {
      const runId = newRun('completed')
      repo.planItems(runId, wsId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'README.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'docs/guide.md' }
      ])

      const { items, total } = svc.listItems(runId)
      assert.equal(total, 2)
      assert.deepEqual(
        items.map((i: { sourceRef: string }) => i.sourceRef).sort(),
        ['README.md', 'docs/guide.md']
      )
    })

    test('listItems filters by status', () => {
      const runId = newRun('completed')
      repo.planItems(runId, wsId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'a.md' },
        { phase: 'docs', kind: 'doc', sourceRef: 'b.md' }
      ])
      const claimed = repo.claimNextItem(runId)
      repo.updateItem(claimed.id, { status: 'failed', error: 'boom' })

      const failedItems = svc.listItems(runId, { status: 'failed' })
      assert.equal(failedItems.total, 1)
      assert.equal(failedItems.items[0].error, 'boom')
    })
  })

  // ── Resume guards ──────────────────────────────────────────────────────

  describe('MemoryBootstrapService.resumeRun', () => {
    test('rejects an unknown run id', async () => {
      await assert.rejects(
        () => svc.resumeRun('no-such-run', '/tmp/nowhere'),
        /not found/i,
        'resuming a run that does not exist must fail loudly'
      )
    })
  })

  // ── Crash recovery ─────────────────────────────────────────────────────

  describe('MemoryBootstrapService.recoverOrphanedRuns', () => {
    test('turns a crash-orphaned run into a resumable paused run', () => {
      const runId = repo.createRun({ workspaceId: wsId, mode: 'full', scope: 'changed' })
      repo.planItems(runId, wsId, [
        { phase: 'docs', kind: 'doc', sourceRef: 'orphan.md', chunkTotal: 6 }
      ])
      repo.updateRun(runId, { status: 'running' })
      const item = repo.claimNextItem(runId)
      repo.bumpChunkDone(item.id, 2, 3)

      svc.recoverOrphanedRuns()

      const run = repo.getRun(runId)
      assert.equal(run.status, 'paused', 'no zombie run blocks the next start')

      const { items } = repo.listItems(runId)
      assert.equal(items[0].status, 'pending', 'the in-flight item is requeued')
      assert.equal(items[0].chunkDone, 2, 'resume continues mid-file rather than re-reading it')
      assert.equal(items[0].factsCreated, 3, 'partial extraction is not discarded')
    })

    test('is idempotent — a second pass changes nothing', () => {
      const runId = repo.createRun({ workspaceId: wsId, mode: 'full', scope: 'changed' })
      repo.updateRun(runId, { status: 'running' })

      svc.recoverOrphanedRuns()
      const afterFirst = repo.getRun(runId).status
      svc.recoverOrphanedRuns()

      assert.equal(afterFirst, 'paused')
      assert.equal(repo.getRun(runId).status, 'paused')
    })

    test('leaves completed and cancelled runs alone', () => {
      const completed = newRun('completed')
      const cancelled = newRun('cancelled')

      svc.recoverOrphanedRuns()

      assert.equal(repo.getRun(completed).status, 'completed')
      assert.equal(repo.getRun(cancelled).status, 'cancelled')
    })
  })
}
