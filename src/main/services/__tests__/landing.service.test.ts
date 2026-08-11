/**
 * Landing against a REAL git repository.
 *
 * Landing is the one operation in this subsystem that can destroy work by being
 * clever, so the properties worth asserting are all about restraint:
 *
 *  - concurrent landings serialise, because two merges into one integration
 *    branch at the same time is a race with a corrupted branch at the end;
 *  - a genuine conflict yields `conflicted` with BOTH branches intact and no
 *    half-finished merge left behind;
 *  - the user's primary checkout is never touched — not its HEAD, not its
 *    working files, not even by the conflicting case.
 *
 * None of that is observable against a mocked git, so every test drives the
 * real binary. Skips cleanly when git isn't on PATH or the DB is unavailable.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import {
  attachTestDb,
  liveTestDb,
  reloadWithRealDeps
} from '../../db/repositories/__tests__/db-test-helper'

const gitAvailable = spawnSync('git', ['--version']).status === 0
const dbContext = attachTestDb()

process.env.AGENT_STUDIO_WORKTREE_ROOT = join(tmpdir(), `landing-root-${process.pid}`)

if (!gitAvailable || !dbContext) {
  describe('LandingService (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  // Resolved per call, never captured: a later test file replaces the global
  // database at import time, which would strand a handle taken here.
  const db = (): import('better-sqlite3').Database => liveTestDb()
  // Reloaded against the real repositories: other files in the shared runner
  // mock the repository layer via Module._load, and anything first required
  // while that was active keeps the mock in its import bindings forever.
  // Repositories first so the services below bind to the real ones.
  const [trackRepoMod, , , trackMod, , landingMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/track-file-claim.repository'),
    require.resolve('../track.service'),
    require.resolve('../track-claims.service'),
    require.resolve('../landing.service')
  ]) as [
    typeof import('../../db/repositories/track.repository'),
    unknown,
    unknown,
    typeof import('../track.service'),
    unknown,
    typeof import('../landing.service')
  ]
  const { trackRepository } = trackRepoMod
  const { trackService } = trackMod
  const { landingService, integrationBranchFor } = landingMod

  let seq = 0

  async function withRepo(
    fn: (ctx: { dir: string; wsId: string }) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'landing-'))
    const wsId = `land-ws-${seq++}`
    try {
      const git = simpleGit(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Code Atelier Test')
      await git.addConfig('commit.gpgsign', 'false')
      await writeFile(join(dir, 'shared.txt'), 'base\n')
      await git.add('.')
      await git.commit('base')

      db()
        .prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(wsId, `Landing workspace ${wsId}`, dir)
      db()
        .prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?')
        .run(JSON.stringify({ landingMode: 'integration' }), wsId)

      await fn({ dir, wsId })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** A track on its own branch with one commit changing `file`. */
  async function makeTrack(
    wsId: string,
    dir: string,
    ownerId: string,
    branch: string,
    file: string,
    contents: string
  ): Promise<{ id: string; path: string; branchName: string }> {
    const target = await trackService.ensureTrack({
      ownerKind: 'manual',
      ownerId,
      workspaceId: wsId,
      repoPath: dir,
      branchName: branch,
      baseBranch: 'main'
    })
    await writeFile(join(target.path, file), contents)
    const row = trackRepository.findByOwner('manual', ownerId)!
    return { id: row.id, path: target.path, branchName: target.branchName as string }
  }

  const headOf = async (d: string): Promise<string> =>
    (await simpleGit(d).revparse(['--abbrev-ref', 'HEAD'])).trim()
  const statusOf = async (d: string): Promise<string> =>
    (await simpleGit(d).raw(['status', '--porcelain'])).trim()

  // ── Mode resolution ────────────────────────────────────────────────

  describe('landing mode', () => {
    test('the default is independent — one PR per track, as /complete always did', async () => {
      await withRepo(async ({ dir, wsId }) => {
        db().prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?').run('{}', wsId)
        const t = await makeTrack(wsId, dir, `mode-a-${wsId}`, 'feat/mode-a', 'a.txt', 'a\n')
        assert.equal(landingService.resolveMode(trackRepository.findById(t.id)!), 'independent')
        await trackService.discard(t.id)
      })
    })

    test('the workspace setting overrides the default', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `mode-b-${wsId}`, 'feat/mode-b', 'b.txt', 'b\n')
        assert.equal(landingService.resolveMode(trackRepository.findById(t.id)!), 'integration')
        await trackService.discard(t.id)
      })
    })

    test('the integration branch is derived from the base, not hardcoded', () => {
      assert.equal(integrationBranchFor('main'), 'integration/main')
      assert.equal(integrationBranchFor('develop'), 'integration/develop')
    })
  })

  // ── The happy path ─────────────────────────────────────────────────

  describe('integration landing', () => {
    test('merges into the integration branch and leaves the primary tree alone', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `land-a-${wsId}`, 'feat/land-a', 'a.txt', 'from a\n')

        const result = await landingService.land(t.id, { commitMessage: 'add a' })

        assert.equal(result.outcome, 'landed')
        assert.equal(result.landedInto, 'integration/main')
        assert.ok(result.commitHash)

        // The user's checkout: same branch, still clean, and none of the
        // landed work has appeared in it.
        assert.equal(await headOf(dir), 'main')
        assert.equal(await statusOf(dir), '')
        assert.equal(existsSync(join(dir, 'a.txt')), false)

        // ...and the track is recorded as landed, which is what branch GC reads.
        const row = trackRepository.findById(t.id)!
        assert.ok(row.landedAt)
        assert.equal(row.landedInto, 'integration/main')

        await trackService.discard(t.id)
      })
    })

    test('a track with nothing its base lacks is not landed as an empty merge', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // No file written — the branch is identical to main.
        const target = await trackService.ensureTrack({
          ownerKind: 'manual',
          ownerId: `empty-${wsId}`,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/empty',
          baseBranch: 'main'
        })
        const row = trackRepository.findByOwner('manual', `empty-${wsId}`)!

        const result = await landingService.land(row.id, { commitMessage: 'nothing' })
        assert.equal(result.outcome, 'nothing-to-land')
        assert.equal(result.landedInto, null)
        assert.equal(trackRepository.findById(row.id)?.landedAt, null)

        assert.ok(existsSync(target.path))
        await trackService.discard(row.id)
      })
    })

    test('two tracks landing concurrently both make it in', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // Different files — no genuine conflict, so any failure here is the
        // race, not the content.
        const a = await makeTrack(wsId, dir, `par-a-${wsId}`, 'feat/par-a', 'a.txt', 'from a\n')
        const b = await makeTrack(wsId, dir, `par-b-${wsId}`, 'feat/par-b', 'b.txt', 'from b\n')

        const [ra, rb] = await Promise.all([
          landingService.land(a.id, { commitMessage: 'add a' }),
          landingService.land(b.id, { commitMessage: 'add b' })
        ])

        assert.equal(ra.outcome, 'landed')
        assert.equal(rb.outcome, 'landed')

        // Both files are present on the integration branch — a lost merge would
        // show up here as one of them missing.
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)!
        assert.ok(integration, 'integration worktree should exist')
        assert.ok(existsSync(join(integration.path, 'a.txt')))
        assert.ok(existsSync(join(integration.path, 'b.txt')))

        assert.equal(await statusOf(dir), '', 'primary tree untouched by either landing')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
        await trackService.discard(integration.id)
      })
    })
  })

  // ── Conflict ───────────────────────────────────────────────────────

  describe('conflicting landing', () => {
    test('yields conflicted with both branches intact and nothing half-merged', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // Same file, incompatible content — a real conflict, not a contrived one.
        const a = await makeTrack(
          wsId,
          dir,
          `cf-a-${wsId}`,
          'feat/cf-a',
          'shared.txt',
          'version A\n'
        )
        const b = await makeTrack(
          wsId,
          dir,
          `cf-b-${wsId}`,
          'feat/cf-b',
          'shared.txt',
          'version B\n'
        )

        const first = await landingService.land(a.id, { commitMessage: 'A wins the race' })
        assert.equal(first.outcome, 'landed')

        const second = await landingService.land(b.id, { commitMessage: 'B collides' })
        assert.equal(second.outcome, 'conflicted')
        assert.equal(second.landedInto, null)
        assert.deepEqual(second.conflictedFiles, ['shared.txt'])

        // Neither branch was rewritten: each still holds its own version.
        assert.equal((await readFile(join(a.path, 'shared.txt'), 'utf8')).trim(), 'version A')
        assert.equal((await readFile(join(b.path, 'shared.txt'), 'utf8')).trim(), 'version B')

        // The integration tree is not left mid-merge — a stuck MERGE_HEAD would
        // trap the next landing.
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)!
        assert.ok(integration, 'the integration worktree should exist after the first landing')
        assert.equal(existsSync(join(integration.path, '.git', 'MERGE_HEAD')), false)
        assert.equal(await statusOf(integration.path), '')

        // A is landed; B is visibly conflicted rather than silently stuck.
        assert.ok(trackRepository.findById(a.id)?.landedAt)
        const bRow = trackRepository.findById(b.id)!
        assert.ok(bRow)
        assert.equal(bRow.status, 'conflicted')
        assert.equal(bRow.landedAt, null)
        assert.equal(bRow.ownerId, `cf-b-${wsId}`, 'a conflicted track keeps its owner')

        // And the user's checkout was never part of any of it.
        assert.equal(await headOf(dir), 'main')
        assert.equal(await statusOf(dir), '')
        assert.equal((await readFile(join(dir, 'shared.txt'), 'utf8')).trim(), 'base')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
        await trackService.discard(integration.id)
      })
    })
  })

  // ── Branch GC ──────────────────────────────────────────────────────

  describe('branch GC', () => {
    test('reclaims landed tracks and deletes their branches', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `gc-a-${wsId}`, 'feat/gc-a', 'gc.txt', 'gc\n')
        await landingService.land(t.id, { commitMessage: 'landed' })

        const reclaimed = await landingService.gcLandedTracks(wsId)
        assert.ok(reclaimed >= 1)

        assert.equal(trackRepository.findById(t.id), undefined, 'row is gone')
        assert.equal(existsSync(t.path), false, 'worktree is gone')

        const branches = await simpleGit(dir).branchLocal()
        assert.equal(branches.all.includes('feat/gc-a'), false, 'dead branch was deleted')
        // The integration branch is NOT collected — it is the destination.
        assert.equal(branches.all.includes('integration/main'), true)

        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('a landed track with new uncommitted work is left alone', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `gc-b-${wsId}`, 'feat/gc-b', 'gc.txt', 'gc\n')
        await landingService.land(t.id, { commitMessage: 'landed' })

        // The user kept working in the tree after it landed.
        await writeFile(join(t.path, 'more-work.txt'), 'not yours to delete\n')

        await landingService.gcLandedTracks(wsId)

        assert.ok(trackRepository.findById(t.id), 'row survived')
        assert.ok(existsSync(join(t.path, 'more-work.txt')), 'new work survived')

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('a conflicted track is never collected', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `gc-c-${wsId}`, 'feat/gc-c', 'gc.txt', 'gc\n')
        await landingService.land(t.id, { commitMessage: 'landed' })
        trackRepository.markConflicted(t.id)

        await landingService.gcLandedTracks(wsId)
        assert.ok(trackRepository.findById(t.id), 'conflicted work is the user’s to resolve')

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
