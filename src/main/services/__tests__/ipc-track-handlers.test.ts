/**
 * track.ipc.ts — the four channels that make worktree retention visible.
 *
 * These handlers shipped without any coverage, and two of them are the kind
 * that only look safe: TRACK_REVEAL opens a directory in the OS file manager,
 * and TRACK_ADOPT re-points an existing tree at a brand-new chat. The tests
 * below pin the properties that keep those from being abusable —
 * reveal resolves its path from the database rather than the renderer payload,
 * and adopt refuses a track somebody still owns instead of stealing it.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub, tryInvokeHandler, getRevealedPaths } from './electron-stub'

setupElectronStub()

// ── Setup ────────────────────────────────────────────────────────────────

let trackRepo: any
let dbReady = false

const wsId = 'ws-track-ipc'

/**
 * Seed the workspace against the database that is live RIGHT NOW.
 *
 * A later test file in the shared runner replaces the global database at import
 * time, so seeding once at import would insert into a database no repository
 * reads any more — and every track insert would then fail its workspace foreign
 * key. Called per track instead; `INSERT OR IGNORE` makes that free.
 */
function ensureWorkspace(): void {
  const { liveTestDb } = require('../../db/repositories/__tests__/db-test-helper')
  liveTestDb()
    .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
    .run(wsId, 'Track IPC workspace', '/tmp/track-ipc-workspace')
}

try {
  process.env.NODE_ENV = 'test'
  // Attach to whatever database the run already has rather than installing a
  // fresh one: `_setDatabaseForTesting` is global, so creating one here would
  // replace it for every file that set one up earlier in the shared runner.
  const {
    attachTestDb,
    reloadWithRealDeps
  } = require('../../db/repositories/__tests__/db-test-helper')
  if (!attachTestDb()) throw new Error('no database')

  // Reloaded as a group against the real repositories: other files in the
  // shared runner mock the repository layer via Module._load, and any of these
  // first required while that was active keeps the mock in its bindings.
  // Repositories first so the services and the IPC module bind to the real ones.
  const [trackRepoMod, , , , , , trackIpc] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/track-file-claim.repository'),
    require.resolve('../track.service'),
    require.resolve('../track-claims.service'),
    require.resolve('../landing.service'),
    require.resolve('../../ipc/track.ipc')
  ])
  trackRepo = (trackRepoMod as { trackRepository: unknown }).trackRepository
  ;(trackIpc as { registerTrackIpc: () => void }).registerTrackIpc()
  dbReady = true
} catch (err) {
  console.log(`\n⚠ track.ipc test setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message.split('\n')[0]})`)
}

if (!dbReady) {
  describe('track.ipc (skipped — DB unavailable)', () => {
    test('handlers', () => {}, { skipReason: 'no DB' })
  })
} else {
  let seq = 0
  const makeTrack = (overrides: Record<string, unknown> = {}): any => {
    seq++
    ensureWorkspace()
    return trackRepo.create({
      workspaceId: wsId,
      ownerKind: 'chat',
      ownerId: `conv-${seq}`,
      branchName: `chat/branch-${seq}`,
      path: `/tmp/agent-studio-test-worktrees/track-${seq}`,
      baseBranch: 'main',
      ...overrides
    })
  }

  // ── track:list ─────────────────────────────────────────────────────────

  describe('track:list', () => {
    test('rejects a missing workspaceId', async () => {
      const r = await tryInvokeHandler('track:list', {})
      assert.equal(r.ok, false)
    })

    test('rejects a non-object payload', async () => {
      const r = await tryInvokeHandler('track:list', 'ws-track-ipc')
      assert.equal(r.ok, false)
    })

    test('returns tracks with the disk budget attached', async () => {
      const row = makeTrack()
      const r = await tryInvokeHandler('track:list', { workspaceId: wsId })
      assert.equal(r.ok, true)
      const result = (r as { result: any }).result
      assert.ok(Array.isArray(result.tracks))
      assert.ok(result.tracks.some((t: any) => t.id === row.id))
      assert.equal(typeof result.budgetBytes, 'number')
      assert.ok(result.budgetBytes > 0)
      // The directory does not exist, so the filesystem facts must say so
      // rather than trusting the row.
      const summary = result.tracks.find((t: any) => t.id === row.id)
      assert.equal(summary.exists, false)
      assert.equal(summary.dirty, false)
      assert.equal(summary.diskBytes, 0)
    })

    test('an unknown workspace yields an empty list, not an error', async () => {
      const r = await tryInvokeHandler('track:list', { workspaceId: 'ws-does-not-exist' })
      assert.equal(r.ok, true)
      assert.deepEqual((r as { result: any }).result.tracks, [])
      assert.equal((r as { result: any }).result.totalBytes, 0)
    })
  })

  // ── track:reveal ───────────────────────────────────────────────────────

  describe('track:reveal', () => {
    // Assertions are on membership rather than array identity: the harness runs
    // tests concurrently, so clearing the shared reveal log would race.
    test('reveals the path stored on the row, never one from the payload', async () => {
      const row = makeTrack()

      const r = await tryInvokeHandler('track:reveal', {
        trackId: row.id,
        // A renderer trying to turn this into "reveal anything on disk".
        path: '/etc',
        trackPath: '/etc'
      })

      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, true)
      assert.ok(getRevealedPaths().includes(row.path))
      assert.ok(!getRevealedPaths().includes('/etc'))
    })

    test('returns false and reveals nothing for an unknown track', async () => {
      const before = getRevealedPaths().length
      const r = await tryInvokeHandler('track:reveal', { trackId: 'no-such-track' })
      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, false)
      // Nothing this call could have revealed: the id resolves to no row.
      assert.ok(
        !getRevealedPaths()
          .slice(before)
          .some((p) => p.includes('no-such-track'))
      )
    })

    test('rejects a missing trackId', async () => {
      const r = await tryInvokeHandler('track:reveal', {})
      assert.equal(r.ok, false)
    })
  })

  // ── track:adopt ────────────────────────────────────────────────────────

  describe('track:adopt', () => {
    test('returns null for a track that still has an owner', async () => {
      const row = makeTrack()
      const r = await tryInvokeHandler('track:adopt', { trackId: row.id })
      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, null)
      // And the owner is untouched — adoption must never steal.
      assert.equal(trackRepo.findById(row.id).ownerId, row.ownerId)
    })

    test('returns null for a retained track whose directory is gone', async () => {
      const row = makeTrack()
      trackRepo.markRetained(row.id)
      const r = await tryInvokeHandler('track:adopt', { trackId: row.id })
      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, null)
    })

    test('returns null for an unknown track', async () => {
      const r = await tryInvokeHandler('track:adopt', { trackId: 'no-such-track' })
      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, null)
    })

    test('rejects a missing trackId', async () => {
      const r = await tryInvokeHandler('track:adopt', {})
      assert.equal(r.ok, false)
    })
  })

  // ── track:land ──────────────────────────────────────────────────
  //
  // The git behaviour lives in landing.service.test.ts (real repositories); what
  // matters here is that the channel refuses a payload it cannot act on rather
  // than landing something arbitrary.

  describe('track:land', () => {
    test('rejects a missing trackId', async () => {
      const r = await tryInvokeHandler('track:land', { commitMessage: 'ship it' })
      assert.equal(r.ok, false)
    })

    test('rejects a missing commitMessage', async () => {
      const row = makeTrack()
      const r = await tryInvokeHandler('track:land', { trackId: row.id })
      assert.equal(r.ok, false)
    })

    test('fails loudly for an unknown track rather than landing nothing quietly', async () => {
      const r = await tryInvokeHandler('track:land', {
        trackId: 'no-such-track',
        commitMessage: 'ship it'
      })
      assert.equal(r.ok, false)
      assert.match((r as { error: Error }).error.message, /not found/i)
    })
  })

  // ── track:discard ──────────────────────────────────────────────────────

  describe('track:discard', () => {
    test('returns false for an unknown track rather than throwing', async () => {
      const r = await tryInvokeHandler('track:discard', { trackId: 'no-such-track' })
      assert.equal(r.ok, true)
      assert.equal((r as { result: unknown }).result, false)
    })

    test('rejects a missing trackId', async () => {
      const r = await tryInvokeHandler('track:discard', {})
      assert.equal(r.ok, false)
    })
  })
}

void summaryAsync()
