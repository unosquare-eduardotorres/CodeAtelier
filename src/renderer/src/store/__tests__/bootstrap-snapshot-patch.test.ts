/**
 * bootstrapSnapshotPatch — the merge rule behind memory.store's
 * `loadBootstrapSnapshot`.
 *
 * Two failures this rule exists to prevent, both caused by `bootstrap` living
 * in a module-level store that outlives navigation:
 *  - a finished run stays on screen forever, because the snapshot stops
 *    reporting terminal progress and nothing else clears the field;
 *  - switching to a workspace with no run leaves the *previous* workspace's
 *    progress up, and its runId then drives the document list.
 *
 * Run: tsx src/renderer/src/store/__tests__/bootstrap-snapshot-patch.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { bootstrapSnapshotPatch } from '../memory-store-utils'
import type { BootstrapSnapshot } from '../memory-store-utils'

const progress = (workspaceId: string, runId: string): BootstrapSnapshot['progress'] =>
  ({
    jobId: 'job-1',
    runId,
    workspaceId,
    phaseIndex: 1,
    phaseCount: 7,
    phaseLabel: 'docs',
    factsCreated: 4,
    message: 'README.md',
    jobStatus: 'running',
    mode: 'full',
    itemsTotal: 10,
    itemsDone: 3,
    itemsSkipped: 0,
    itemsFailed: 0,
    currentItem: null,
    perPhase: {},
    etaSeconds: 30,
    itemsPerMinute: 2
  }) as BootstrapSnapshot['progress']

const run = (id: string): BootstrapSnapshot['latestRun'] =>
  ({ id, status: 'completed' }) as BootstrapSnapshot['latestRun']

describe('bootstrapSnapshotPatch', () => {
  test('re-attaches an in-flight run for the workspace on screen', () => {
    const patch = bootstrapSnapshotPatch(
      { progress: progress('ws-a', 'run-a'), latestRun: run('run-a'), resumableRunId: null },
      'ws-a',
      'ws-a'
    )

    assert.ok(patch)
    assert.equal(patch?.bootstrap?.runId, 'run-a')
    assert.equal(patch?.bootstrapLatestRun?.id, 'run-a')
  })

  test('clears bootstrap when the workspace has no live run', () => {
    // The finished-state summary is gated on `bootstrap === null`; leaving the
    // last live value in place hides it until the app restarts.
    const patch = bootstrapSnapshotPatch(
      { progress: null, latestRun: run('run-a'), resumableRunId: null },
      'ws-a',
      'ws-a'
    )

    assert.ok(patch)
    assert.equal(patch?.bootstrap, null, 'a settled run must not stay pinned open')
    assert.equal(patch?.bootstrapLatestRun?.id, 'run-a', 'history still renders')
  })

  test('a workspace with no run does not inherit the previous one', () => {
    // Workspace B has never ingested. Without the clear, B's page shows A's
    // progress and loads A's documents.
    const patch = bootstrapSnapshotPatch(
      { progress: null, latestRun: null, resumableRunId: null },
      'ws-b',
      'ws-b'
    )

    assert.deepEqual(patch, {
      bootstrap: null,
      bootstrapLatestRun: null,
      bootstrapResumableRunId: null
    })
  })

  test('a background workspace snapshot never touches the page on screen', () => {
    // Terminal progress for any workspace triggers a snapshot load; applying it
    // would blank (or repaint) the run the user is watching.
    const patch = bootstrapSnapshotPatch(
      { progress: null, latestRun: run('run-b'), resumableRunId: 'run-b' },
      'ws-b',
      'ws-a'
    )

    assert.equal(patch, null)
  })

  test('carries the resumable run id so Resume is offered after a restart', () => {
    const patch = bootstrapSnapshotPatch(
      { progress: null, latestRun: run('run-a'), resumableRunId: 'run-a' },
      'ws-a',
      'ws-a'
    )

    assert.equal(patch?.bootstrapResumableRunId, 'run-a')
  })

  test('treats "no workspace selected" as not the viewed workspace', () => {
    const patch = bootstrapSnapshotPatch(
      { progress: progress('ws-a', 'run-a'), latestRun: null, resumableRunId: null },
      'ws-a',
      null
    )

    assert.equal(patch, null)
  })
})

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('bootstrap-snapshot-patch')) {
  void summaryAsync()
}
