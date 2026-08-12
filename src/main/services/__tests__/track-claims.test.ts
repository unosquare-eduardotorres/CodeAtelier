/**
 * Cross-track conflict prediction, against REAL git.
 *
 * Blueprint's wave scheduler already refuses to run two tasks touching the same
 * file. That guard is why parallel BUILD is safe, and it is scoped to one wave
 * of one run — so two *tracks* editing the same file stayed invisible until one
 * of them landed and hit a merge conflict, with both sets of work already
 * written.
 *
 * What matters here is exactly what makes the prediction useful rather than
 * noisy:
 *
 *  - claims are recorded as workspace-RELATIVE paths, because every track lives
 *    in a different directory and absolute paths would never match;
 *  - both committed and uncommitted work count, because an agent that commits
 *    every turn and one that never commits are equally common;
 *  - only live tracks are compared, because a retained or landed track cannot
 *    collide with anything and warning about it is pure noise.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

process.env.AGENT_STUDIO_WORKTREE_ROOT = join(tmpdir(), `claims-root-${process.pid}`)

if (!gitAvailable || !dbContext) {
  describe('Track claims (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  // Resolved per call, never captured: a later test file replaces the global
  // database at import time, which would strand a handle taken here.
  const db = (): import('better-sqlite3').Database => liveTestDb()
  // See landing.service.test.ts — anything required under another file's
  // repository mock keeps that mock in its bindings. Repositories first.
  const [trackRepoMod, , claimRepoMod, trackMod, claimsMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/track-file-claim.repository'),
    require.resolve('../track.service'),
    require.resolve('../track-claims.service')
  ]) as [
    typeof import('../../db/repositories/track.repository'),
    unknown,
    typeof import('../../db/repositories/track-file-claim.repository'),
    typeof import('../track.service'),
    typeof import('../track-claims.service')
  ]
  const { trackRepository } = trackRepoMod
  const { trackFileClaimRepository } = claimRepoMod
  const { trackService } = trackMod
  const { trackClaimsService } = claimsMod

  let seq = 0

  async function withRepo(
    fn: (ctx: { dir: string; wsId: string }) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'claims-'))
    const wsId = `claims-ws-${seq++}`
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
        .run(wsId, `Claims workspace ${wsId}`, dir)
      await fn({ dir, wsId })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function makeTrack(
    wsId: string,
    dir: string,
    ownerId: string,
    branch: string
  ): Promise<{ id: string; path: string }> {
    const target = await trackService.ensureTrack({
      ownerKind: 'manual',
      ownerId,
      workspaceId: wsId,
      repoPath: dir,
      branchName: branch,
      baseBranch: 'main'
    })
    const row = trackRepository.findByOwner('manual', ownerId)!
    return { id: row.id, path: target.path }
  }

  // ── Recording ──────────────────────────────────────────────────────

  describe('recording what a track touched', () => {
    test('records uncommitted work as workspace-relative paths', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `rec-a-${wsId}`, 'feat/rec-a')
        await writeFile(join(t.path, 'shared.txt'), 'edited\n')
        await writeFile(join(t.path, 'brand-new.ts'), 'export const x = 1\n')

        await trackClaimsService.recordForTrack(t.id)

        const paths = trackFileClaimRepository
          .findByTrack(t.id)
          .map((c: { filePath: string }) => c.filePath)
        assert.deepEqual(paths, ['brand-new.ts', 'shared.txt'])
        // Absolute paths would never match another worktree's — that failure
        // mode is silent, so it is asserted explicitly.
        assert.ok(!paths.some((p: string) => p.startsWith('/')))

        await trackService.discard(t.id)
      })
    })

    test('records committed work too — an agent that commits still claims files', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `rec-b-${wsId}`, 'feat/rec-b')
        await writeFile(join(t.path, 'committed.ts'), 'export const y = 1\n')
        const g = simpleGit(t.path)
        await g.add(['committed.ts'])
        await g.commit('work')

        await trackClaimsService.recordForTrack(t.id)

        const paths = trackFileClaimRepository
          .findByTrack(t.id)
          .map((c: { filePath: string }) => c.filePath)
        assert.deepEqual(paths, ['committed.ts'])

        await trackService.discard(t.id)
      })
    })

    test('re-recording is an upsert — first_seen_at survives', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `rec-c-${wsId}`, 'feat/rec-c')
        await writeFile(join(t.path, 'shared.txt'), 'edited\n')

        await trackClaimsService.recordForTrack(t.id)
        const first = trackFileClaimRepository.findByTrack(t.id)[0]

        await writeFile(join(t.path, 'shared.txt'), 'edited again\n')
        await trackClaimsService.recordForTrack(t.id)
        const after = trackFileClaimRepository.findByTrack(t.id)

        assert.equal(after.length, 1, 'no duplicate row per turn')
        assert.equal(after[0].firstSeenAt, first.firstSeenAt, 'who got here first is preserved')

        await trackService.discard(t.id)
      })
    })

    test('a track with no changes records nothing', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `rec-d-${wsId}`, 'feat/rec-d')
        const recorded = await trackClaimsService.recordForTrack(t.id)
        assert.equal(recorded, 0)
        assert.deepEqual(trackFileClaimRepository.findByTrack(t.id), [])
        await trackService.discard(t.id)
      })
    })

    test('an unknown track is a no-op, not a throw', async () => {
      assert.equal(await trackClaimsService.recordForTrack('no-such-track'), 0)
    })
  })

  // ── Prediction ─────────────────────────────────────────────────────

  describe('predicting collisions', () => {
    test('two live tracks editing one file are reported against each other', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const a = await makeTrack(wsId, dir, `ov-a-${wsId}`, 'feat/ov-a')
        const b = await makeTrack(wsId, dir, `ov-b-${wsId}`, 'feat/ov-b')
        await writeFile(join(a.path, 'shared.txt'), 'A\n')
        await writeFile(join(b.path, 'shared.txt'), 'B\n')
        await trackClaimsService.recordForTrack(a.id)
        await trackClaimsService.recordForTrack(b.id)

        const overlaps = trackClaimsService.overlaps(wsId)
        assert.equal(overlaps.length, 1)
        assert.equal(overlaps[0].filePath, 'shared.txt')
        assert.deepEqual([...overlaps[0].trackIds].sort(), [a.id, b.id].sort())

        // Named, from either side — a count is not actionable.
        const fromA = trackClaimsService.conflictsFor(wsId, a.id)
        assert.equal(fromA.length, 1)
        assert.equal(fromA[0].others[0].branchName, 'feat/ov-b')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
      })
    })

    test('tracks touching different files do not collide', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const a = await makeTrack(wsId, dir, `nc-a-${wsId}`, 'feat/nc-a')
        const b = await makeTrack(wsId, dir, `nc-b-${wsId}`, 'feat/nc-b')
        await writeFile(join(a.path, 'only-a.ts'), 'a\n')
        await writeFile(join(b.path, 'only-b.ts'), 'b\n')
        await trackClaimsService.recordForTrack(a.id)
        await trackClaimsService.recordForTrack(b.id)

        assert.deepEqual(trackClaimsService.overlaps(wsId), [])

        await trackService.discard(a.id)
        await trackService.discard(b.id)
      })
    })

    test('a retained track is not warned about — it cannot collide with anything', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const a = await makeTrack(wsId, dir, `rt-a-${wsId}`, 'feat/rt-a')
        const b = await makeTrack(wsId, dir, `rt-b-${wsId}`, 'feat/rt-b')
        await writeFile(join(a.path, 'shared.txt'), 'A\n')
        await writeFile(join(b.path, 'shared.txt'), 'B\n')
        await trackClaimsService.recordForTrack(a.id)
        await trackClaimsService.recordForTrack(b.id)
        assert.equal(trackClaimsService.overlaps(wsId).length, 1)

        trackRepository.markRetained(b.id)
        assert.deepEqual(trackClaimsService.overlaps(wsId), [], 'parked work is not a collision')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
      })
    })

    test('a landed track is not warned about either', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const a = await makeTrack(wsId, dir, `ld-a-${wsId}`, 'feat/ld-a')
        const b = await makeTrack(wsId, dir, `ld-b-${wsId}`, 'feat/ld-b')
        await writeFile(join(a.path, 'shared.txt'), 'A\n')
        await writeFile(join(b.path, 'shared.txt'), 'B\n')
        await trackClaimsService.recordForTrack(a.id)
        await trackClaimsService.recordForTrack(b.id)

        trackRepository.markLanded(b.id, 'integration/main')
        assert.deepEqual(trackClaimsService.overlaps(wsId), [], 'finished work is not a collision')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
      })
    })

    test('claims die with their track', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `cascade-${wsId}`, 'feat/cascade')
        await writeFile(join(t.path, 'shared.txt'), 'x\n')
        await trackClaimsService.recordForTrack(t.id)
        assert.equal(trackFileClaimRepository.findByTrack(t.id).length, 1)

        await trackService.discard(t.id)
        assert.deepEqual(
          trackFileClaimRepository.findByTrack(t.id),
          [],
          'ON DELETE CASCADE — a dead track cannot leave claims behind'
        )
      })
    })
  })

  // ── Surfaced on the Tracks list ────────────────────────────────────

  describe('summarize', () => {
    test('carries the predicted collisions the panel renders', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const a = await makeTrack(wsId, dir, `sum-a-${wsId}`, 'feat/sum-a')
        const b = await makeTrack(wsId, dir, `sum-b-${wsId}`, 'feat/sum-b')
        await writeFile(join(a.path, 'shared.txt'), 'A\n')
        await writeFile(join(b.path, 'shared.txt'), 'B\n')
        await trackClaimsService.recordForTrack(a.id)
        await trackClaimsService.recordForTrack(b.id)

        const summaries = await trackService.summarize(wsId)
        const sa = summaries.find((s: { id: string }) => s.id === a.id)!
        assert.ok(sa, 'the track must appear in its own workspace summary')
        assert.equal(sa.conflicts.length, 1)
        assert.equal(sa.conflicts[0].filePath, 'shared.txt')
        assert.equal(sa.conflicts[0].others[0].branchName, 'feat/sum-b')

        await trackService.discard(a.id)
        await trackService.discard(b.id)
      })
    })

    test('a workspace with no claims reports no conflicts rather than failing', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `sum-c-${wsId}`, 'feat/sum-c')
        const summaries = await trackService.summarize(wsId)
        assert.deepEqual(summaries[0].conflicts, [])
        await trackService.discard(t.id)
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
