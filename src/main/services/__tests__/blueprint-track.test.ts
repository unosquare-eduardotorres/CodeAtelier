/**
 * Blueprint runs get their own working tree — against REAL git.
 *
 * BUILD used to run every one of its parallel agents with `cwd =
 * workspace.repoPath`: the branch the user is sitting on, with the user's
 * uncommitted edits in it. The only guard was a process-wide lock, which bought
 * safety by giving up the parallelism BUILD exists for and did nothing about
 * output landing in someone's working copy.
 *
 * Two properties carry the weight here and neither is observable without a real
 * repository:
 *
 *   - BUILD's writes land in the run's tree and the primary tree's `git status`
 *     stays clean.
 *   - Task file verification resolves against that tree, so a claim pointing
 *     outside it is still rejected — the traversal guard must not have been
 *     widened by moving the root.
 *
 * Skips cleanly when git isn't on PATH or the DB native module is unavailable.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

process.env.AGENT_STUDIO_WORKTREE_ROOT = join(tmpdir(), `bp-track-root-${process.pid}`)

if (!gitAvailable || !dbContext) {
  describe('Blueprint tracks (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  // Resolved per call, never captured: a later test file replaces the global
  // database at import time, which would strand a handle taken here.
  const db = (): import('better-sqlite3').Database => liveTestDb()
  // See landing.service.test.ts — anything required under another file's
  // repository mock keeps that mock in its bindings. `ensureBlueprintTrack`
  // reads workspace settings, so a mocked workspaceRepository silently reports
  // "not opted out" and the degradation tests below assert the wrong thing.
  // Repositories first so the services bind to the real ones.
  const [, , , trackMod, blueprintTrackMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/blueprint.repository'),
    require.resolve('../track.service'),
    require.resolve('../blueprint-track')
  ]) as [
    unknown,
    unknown,
    unknown,
    typeof import('../track.service'),
    typeof import('../blueprint-track')
  ]
  const { trackService } = trackMod
  const { ensureBlueprintTrack, resolveBlueprintTrack, blueprintTrackBranch, blueprintTrackOwner } =
    blueprintTrackMod
  const { verifyTaskFileClaims } = require('../blueprint-task-verification')

  let seq = 0

  /** Temp repo on `main` with one commit, plus its workspace + blueprint rows. */
  async function withBlueprint(
    fn: (ctx: { dir: string; wsId: string; bpId: string }) => Promise<void>,
    opts?: { gitAutoBranch?: boolean }
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'bp-track-'))
    const wsId = `bp-ws-${seq++}`
    try {
      const git = simpleGit(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Code Atelier Test')
      await git.addConfig('commit.gpgsign', 'false')
      await writeFile(join(dir, 'README.md'), '# base\n')
      await git.add('.')
      await git.commit('base')

      db()
        .prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(wsId, `BP workspace ${wsId}`, dir)
      if (opts?.gitAutoBranch === false) {
        db()
          .prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?')
          .run(JSON.stringify({ gitAutoBranch: false }), wsId)
      }

      const bp = db()
        .prepare(
          `INSERT INTO blueprints (workspace_id, title, description)
           VALUES (?, ?, ?) RETURNING id`
        )
        .get(wsId, 'Add retry to uploads', 'desc') as { id: string }

      await fn({ dir, wsId, bpId: bp.id })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const headOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD'])).trim()

  const statusOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).raw(['status', '--porcelain'])).trim()

  // ── Branch naming ──────────────────────────────────────────────────

  describe('blueprint branch naming', () => {
    test('slugs the title and suffixes the id, so two same-titled runs differ', () => {
      const a = blueprintTrackBranch('aaaaaaaa1111', 'Add retry to uploads')
      const b = blueprintTrackBranch('bbbbbbbb2222', 'Add retry to uploads')
      assert.equal(a, 'blueprint/add-retry-to-uploads-aaaaaaaa')
      assert.notEqual(a, b, 'git allows a branch in exactly one worktree repo-wide')
    })

    test('a title of pure punctuation still yields a usable branch', () => {
      const name = blueprintTrackBranch('cccccccc3333', '!!! ???')
      assert.match(name, /^blueprint\/[a-z0-9-]+$/)
    })
  })

  // ── Isolation ──────────────────────────────────────────────────────

  describe('BUILD works in its own tree', () => {
    test('ensure creates a worktree on a blueprint branch, primary HEAD untouched', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, true)
        assert.notEqual(target.path, dir)
        assert.ok(existsSync(target.path))
        assert.match(target.branchName ?? '', /^blueprint\/add-retry-to-uploads-/)
        assert.equal(await headOf(dir), 'main', 'the user’s checkout did not move')

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('BUILD writes land in the track; the primary tree stays clean', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        // What a build agent does.
        await writeFile(join(target.path, 'src-new-file.ts'), 'export const retry = 1\n')

        assert.ok(existsSync(join(target.path, 'src-new-file.ts')))
        assert.equal(
          existsSync(join(dir, 'src-new-file.ts')),
          false,
          'blueprint output must not appear in the user’s checkout'
        )
        assert.equal(await statusOf(dir), '', 'the primary tree’s git status stays clean')

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('the run is idempotent — a second ensure reuses the same tree', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const first = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        const second = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(second.path, first.path)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('VERIFY resolves the tree BUILD created, without creating anything', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const built = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        const resolved = resolveBlueprintTrack(bpId, dir)
        assert.equal(resolved.path, built.path)
        assert.equal(resolved.isolated, true)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('a blueprint id resolves the same owner key both phases use', () => {
      assert.deepEqual(blueprintTrackOwner('bp-1'), { ownerKind: 'blueprint', ownerId: 'bp-1' })
    })
  })

  // ── Degradation ────────────────────────────────────────────────────
  //
  // Failing BUILD because a worktree could not be created would be a
  // regression; running in the shared tree is the old behaviour, and the caller
  // takes the primary-tree lock when `isolated` comes back false.

  describe('when isolation is unavailable', () => {
    test('a workspace that opted out of auto-branching runs in the primary tree', async () => {
      await withBlueprint(
        async ({ dir, wsId, bpId }) => {
          const target = await ensureBlueprintTrack({
            blueprintId: bpId,
            workspaceId: wsId,
            workspacePath: dir
          })
          assert.equal(target.isolated, false)
          assert.equal(target.path, dir)
        },
        { gitAutoBranch: false }
      )
    })

    test('a branch already held by other work degrades instead of throwing', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // Somebody else owns the branch this blueprint wants.
        const branch = blueprintTrackBranch(bpId, 'Add retry to uploads')
        await trackService.ensureTrack({
          ownerKind: 'manual',
          ownerId: `squatter-${bpId}`,
          workspaceId: wsId,
          repoPath: dir,
          branchName: branch
        })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(target.isolated, false, 'degrades to the primary tree')
        assert.equal(target.path, dir)

        await trackService.releaseTrack('manual', `squatter-${bpId}`, { discard: true })
      })
    })

    test('resolve falls back to the primary tree when no track exists', async () => {
      await withBlueprint(async ({ dir, bpId }) => {
        const resolved = resolveBlueprintTrack(bpId, dir)
        assert.equal(resolved.isolated, false)
        assert.equal(resolved.path, dir)
      })
    })
  })

  // ── Verification still guards traversal ────────────────────────────

  describe('task file verification against the track root', () => {
    test('a claim inside the track passes; one escaping it is still rejected', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        const startedAt = Date.now()
        await writeFile(join(target.path, 'in-track.ts'), 'export const a = 1\n')

        const ok = verifyTaskFileClaims(
          target.path,
          { filesCreated: ['in-track.ts'] },
          [],
          startedAt
        )
        assert.equal(ok.ok, true, 'a file written in the track must verify')

        // Exists on disk, outside the track. Moving the verification root must
        // not have turned the traversal guard into an escape hatch.
        const escaping = verifyTaskFileClaims(
          target.path,
          { filesCreated: ['../../README.md'] },
          [],
          startedAt
        )
        assert.equal(escaping.ok, false)
        assert.deepEqual(escaping.missingClaimed, ['../../README.md'])

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('verifying against the WRONG root fails every claim', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        const startedAt = Date.now()
        await writeFile(join(target.path, 'only-in-track.ts'), 'export const a = 1\n')

        // This is what shipped before the fix: the primary tree as the root.
        // It is not a subtle degradation — every claim in the task is rejected.
        const wrong = verifyTaskFileClaims(
          dir,
          { filesCreated: ['only-in-track.ts'] },
          [],
          startedAt
        )
        assert.equal(wrong.ok, false)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })
  })

  // ── Abort ──────────────────────────────────────────────────────────

  describe('abort mid-BUILD', () => {
    test('retains the tree rather than deleting uncommitted work', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        await writeFile(join(target.path, 'half-finished.ts'), 'export const partial = 1\n')

        // Whatever tears the run down must not use the discard path.
        const outcome = await trackService.releaseTrack('blueprint', bpId)
        assert.equal(outcome, 'retained')
        assert.ok(existsSync(join(target.path, 'half-finished.ts')), 'work survived')

        const rows = trackService.list(wsId).filter((r: { path: string }) => r.path === target.path)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].status, 'retained')
        assert.equal(rows[0].ownerId, null, 'retained work belongs to the user, not the run')

        await trackService.discard(rows[0].id)
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
