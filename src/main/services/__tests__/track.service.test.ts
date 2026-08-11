/**
 * Integration tests for TrackService against a REAL git repository.
 *
 * The bug this service exists to kill is invisible to a mocked git: three
 * conversations sharing one working tree, each believing it is on its own
 * branch, silently committing over each other. Proving it is fixed requires
 * asserting on actual HEADs and actual files on disk, so every test here drives
 * the real binary against a temp repo.
 *
 * Two assertions carry most of the weight:
 *   - "writes in a worktree are invisible to the primary tree" — the isolation
 *     claim itself.
 *   - "release does not follow the node_modules symlink" — the destructive
 *     failure mode, where a forced recursive delete reaches through the link
 *     and eats the real dependency tree.
 *
 * Skips cleanly when git isn't on PATH or the DB native module is unavailable.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'

const gitAvailable = spawnSync('git', ['--version']).status === 0
const dbContext = attachTestDb()

// Read at call time by worktreesRoot(), so setting it here is enough — but it
// must happen before any ensure() runs.
const WORKTREE_ROOT = join(tmpdir(), `wt-svc-root-${process.pid}`)
process.env.AGENT_STUDIO_WORKTREE_ROOT = WORKTREE_ROOT

type Git = ReturnType<typeof simpleGit>

if (!gitAvailable || !dbContext) {
  describe('TrackService (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  const { db } = dbContext
  const {
    trackService,
    TrackConflictError,
    primaryTreeLock,
    primaryTreeBusyError
  } = require('../track.service')
  const { trackRepository } = require('../../db/repositories/track.repository')

  let convSeq = 0
  function seedConv(workspaceId: string): string {
    const row = db
      .prepare(
        `INSERT INTO conversations (workspace_id, title, mode) VALUES (?, ?, 'plan') RETURNING id`
      )
      .get(workspaceId, `WT conv ${convSeq++}`) as { id: string }
    return row.id
  }

  /**
   * Temp repo with one commit on `main`, plus a workspace row whose repoPath
   * points at it.
   *
   * The workspace must be per-repo: teardown resolves the owning repository
   * through `workspaces.repo_path`, so a fixture pointing somewhere else would
   * silently exercise the "no primary tree" branch and prove nothing about the
   * real deregistration path.
   */
  let wsSeq = 0
  async function withRepo(
    fn: (git: Git, dir: string, wsId: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'wt-svc-'))
    try {
      const git = simpleGit(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Code Atelier Test')
      await git.addConfig('commit.gpgsign', 'false')
      await writeFile(join(dir, 'README.md'), '# base\n')
      await git.add('.')
      await git.commit('base')

      const wsId = `wt-ws-${wsSeq++}`
      db.prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)').run(
        wsId,
        `WT workspace ${wsId}`,
        dir
      )

      await fn(git, dir, wsId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const headOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD'])).trim()

  // ── The isolation claim ───────────────────────────────────────────

  describe('TrackService × real git — isolation', () => {
    test('gives a conversation its own tree on its own branch', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/isolated'
        })

        assert.equal(target.isolated, true)
        assert.notEqual(target.path, dir, 'must not be the primary tree')
        assert.ok(existsSync(target.path), 'directory exists on disk')
        assert.equal(await headOf(target.path), 'feat/isolated')
        assert.equal(await headOf(dir), 'main', 'primary HEAD is untouched')

        await trackService.release(conv)
      })
    })

    test('writes in a worktree are invisible to the primary tree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/writes'
        })

        await writeFile(join(target.path, 'agent-output.txt'), 'written by chat A\n')

        assert.ok(existsSync(join(target.path, 'agent-output.txt')))
        assert.equal(
          existsSync(join(dir, 'agent-output.txt')),
          false,
          'this is the whole point: chat A cannot dirty the shared tree'
        )

        await trackService.release(conv)
      })
    })

    test('two conversations on different branches never see each other', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const a = seedConv(wsId)
        const b = seedConv(wsId)

        const ta = await trackService.ensure({
          conversationId: a,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/parallel-a'
        })
        const tb = await trackService.ensure({
          conversationId: b,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/parallel-b'
        })

        assert.notEqual(ta.path, tb.path)
        await writeFile(join(ta.path, 'a.txt'), 'A\n')
        await writeFile(join(tb.path, 'b.txt'), 'B\n')

        assert.equal(existsSync(join(ta.path, 'b.txt')), false)
        assert.equal(existsSync(join(tb.path, 'a.txt')), false)
        assert.equal(await headOf(ta.path), 'feat/parallel-a')
        assert.equal(await headOf(tb.path), 'feat/parallel-b')

        await trackService.release(a)
        await trackService.release(b)
      })
    })

    test('checks out an existing branch instead of recreating it', async () => {
      await withRepo(async (git, dir, wsId) => {
        await git.raw(['branch', 'feat/preexisting'])
        const conv = seedConv(wsId)

        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/preexisting'
        })

        assert.equal(await headOf(target.path), 'feat/preexisting')
        await trackService.release(conv)
      })
    })
  })

  // ── Cases that must NOT produce a worktree ────────────────────────

  describe('TrackService — primary-tree fallbacks', () => {
    test('a conversation with no branch runs in the primary tree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: null
        })

        assert.deepEqual(target, { path: dir, branchName: null, isolated: false })
        assert.equal(trackRepository.findByOwner('chat', conv), undefined, 'no row created')
      })
    })

    test('a branch already checked out in the primary tree is used in place', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        // Primary tree is on `main`; the chat claims `main` too. Git cannot
        // check one branch out twice, so this must be a normal outcome.
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'main'
        })

        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.equal(target.branchName, 'main')
        assert.equal(trackRepository.findByOwner('chat', conv), undefined)
      })
    })
  })

  // ── Conflict + idempotency ────────────────────────────────────────

  describe('TrackService — conflicts and repeated calls', () => {
    test('ensure is idempotent — the same call returns the same tree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const opts = {
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/idempotent'
        }

        const first = await trackService.ensure(opts)
        const second = await trackService.ensure(opts)

        assert.equal(second.path, first.path, 'called every turn — must not churn')
        assert.equal(
          trackRepository
            .findByWorkspace(wsId)
            .filter((w: { ownerId: string }) => w.ownerId === conv).length,
          1
        )

        await trackService.release(conv)
      })
    })

    test('a second chat claiming a held branch fails loudly', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const a = seedConv(wsId)
        const b = seedConv(wsId)
        await trackService.ensure({
          conversationId: a,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/contested'
        })

        await assert.rejects(
          () =>
            trackService.ensure({
              conversationId: b,
              workspaceId: wsId,
              repoPath: dir,
              branchName: 'feat/contested'
            }),
          (err: Error) => {
            assert.ok(err instanceof TrackConflictError)
            assert.match(err.message, /already checked out by other work/)
            return true
          },
          'silently sharing the branch is the corruption we are preventing'
        )

        await trackService.release(a)
      })
    })

    test('switching a chat to a new branch rebuilds its tree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const before = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/before'
        })

        const after = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/after'
        })

        assert.notEqual(after.path, before.path)
        assert.equal(await headOf(after.path), 'feat/after')
        assert.equal(existsSync(before.path), false, 'old tree is cleaned up')

        await trackService.release(conv)
      })
    })
  })

  // ── Recovery ──────────────────────────────────────────────────────

  describe('TrackService — recovery from a broken tree', () => {
    test('resolve falls back to the primary tree when the directory vanished', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/vanish'
        })

        await rm(target.path, { recursive: true, force: true })

        const resolved = trackService.resolve(conv, dir)
        assert.equal(resolved.isolated, false)
        assert.equal(resolved.path, dir)

        await trackService.release(conv)
      })
    })

    test('ensure rebuilds a manually deleted worktree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const opts = {
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/rebuild'
        }
        const first = await trackService.ensure(opts)
        await rm(first.path, { recursive: true, force: true })

        const rebuilt = await trackService.ensure(opts)

        assert.ok(existsSync(rebuilt.path), 'self-heals rather than failing the turn')
        assert.equal(await headOf(rebuilt.path), 'feat/rebuild')

        await trackService.release(conv)
      })
    })

    test('pruneOrphans reclaims rows whose directory is gone', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/orphan'
        })
        await rm(target.path, { recursive: true, force: true })

        const reclaimed = await trackService.pruneOrphans()

        assert.ok(reclaimed >= 1)
        assert.equal(trackRepository.findByOwner('chat', conv), undefined)
      })
    })

    test('release frees the branch for another chat', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const a = seedConv(wsId)
        const b = seedConv(wsId)
        await trackService.ensure({
          conversationId: a,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/handover'
        })

        await trackService.release(a)

        const target = await trackService.ensure({
          conversationId: b,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/handover'
        })
        assert.equal(target.isolated, true)

        await trackService.release(b)
      })
    })
  })

  // ── The destructive failure mode ──────────────────────────────────

  describe('TrackService — node_modules linking', () => {
    test('links node_modules instead of copying it', async () => {
      await withRepo(async (_git, dir, wsId) => {
        await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
        await writeFile(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1\n')

        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/deps'
        })

        const linked = join(target.path, 'node_modules')
        assert.ok(lstatSync(linked).isSymbolicLink(), 'a copy would be 1.3 GB per chat')
        assert.equal(
          await readFile(join(linked, 'left-pad', 'index.js'), 'utf8'),
          'module.exports=1\n',
          'dependencies are usable from inside the worktree'
        )

        await trackService.release(conv)
      })
    })

    test('release never deletes the primary tree dependencies through the link', async () => {
      await withRepo(async (_git, dir, wsId) => {
        await mkdir(join(dir, 'node_modules', 'precious'), { recursive: true })
        const sentinel = join(dir, 'node_modules', 'precious', 'do-not-delete.txt')
        await writeFile(sentinel, 'irreplaceable\n')

        const conv = seedConv(wsId)
        await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/safe-teardown'
        })

        await trackService.release(conv)

        assert.ok(
          existsSync(sentinel),
          'a forced recursive delete must never reach through node_modules'
        )
        assert.equal(
          await readFile(sentinel, 'utf8'),
          'irreplaceable\n',
          'primary dependencies survive teardown intact'
        )
      })
    })
  })

  // ── Never lose work ────────────────────────────────────────────
  //
  // Teardown is `git worktree remove --force`, a forced recursive delete. On
  // `/complete` that is safe — the commit already happened. On chat close and
  // chat delete it silently destroyed everything the agent wrote and never
  // committed. These tests exist because that is unrecoverable: there is no
  // reflog entry, no stash, no undo for a file that was never added.

  describe('TrackService — never deletes uncommitted work', () => {
    test('a dirty tree is retained, not deleted, when its chat goes away', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/unfinished'
        })
        const work = join(target.path, 'half-written-feature.ts')
        await writeFile(work, 'export const almost = true\n')

        const outcome = await trackService.release(conv)

        assert.equal(outcome, 'retained')
        assert.ok(existsSync(work), 'the agent’s uncommitted work is still on disk')
        assert.equal(
          await readFile(work, 'utf8'),
          'export const almost = true\n',
          'and it is byte-identical — retention is not a partial save'
        )

        const row = trackRepository.findByBranch(wsId, 'feat/unfinished')
        assert.ok(row, 'the tree stays on the books so it can be found again')
        assert.equal(row.status, 'retained')
        assert.equal(row.ownerId, null, 'detached from the chat that is being deleted')

        await trackService.release(conv, { discard: true })
      })
    })

    test('modified tracked files count as work, not just new ones', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/edited'
        })
        // An edit to a committed file leaves no `??` entry — a naive
        // untracked-only check would call this tree clean and delete it.
        await writeFile(join(target.path, 'README.md'), '# base\n\nedited by the agent\n')

        assert.equal(await trackService.release(conv), 'retained')
        assert.match(await readFile(join(target.path, 'README.md'), 'utf8'), /edited by the agent/)
      })
    })

    test('a retained tree survives deletion of its conversation row', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/outlives-its-chat'
        })
        await writeFile(join(target.path, 'work.txt'), 'keep me\n')
        await trackService.release(conv)

        // This is what chat delete does next. Under the v139 schema the row had
        // ON DELETE CASCADE, so the directory became invisible: unreachable by
        // branch lookup, unknown to the reaper, and impossible to offer back.
        db.prepare('DELETE FROM conversations WHERE id = ?').run(conv)

        const row = trackRepository.findByBranch(wsId, 'feat/outlives-its-chat')
        assert.ok(row, 'the cascade must not take the record of parked work')
        assert.ok(existsSync(join(target.path, 'work.txt')))
      })
    })

    test('a clean tree is still removed — retention is not a leak', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/tidy'
        })

        assert.equal(await trackService.release(conv), 'removed')
        assert.equal(existsSync(target.path), false)
        assert.equal(trackRepository.findByBranch(wsId, 'feat/tidy'), undefined)
      })
    })

    test('committed work counts as clean — the /complete path still reclaims', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/shipped'
        })
        await writeFile(join(target.path, 'shipped.txt'), 'done\n')
        const wtGit = simpleGit(target.path)
        await wtGit.addConfig('user.email', 'test@example.com')
        await wtGit.addConfig('user.name', 'Code Atelier Test')
        await wtGit.addConfig('commit.gpgsign', 'false')
        await wtGit.add('.')
        await wtGit.commit('ship it')

        assert.equal(
          await trackService.release(conv),
          'removed',
          'the branch holds the work now — nothing would be lost'
        )
        assert.equal(existsSync(target.path), false)
      })
    })

    test('discard: true removes a dirty tree — but only when asked', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/abandoned'
        })
        await writeFile(join(target.path, 'scratch.txt'), 'throwaway\n')

        assert.equal(await trackService.release(conv), 'retained', 'default refuses')
        assert.equal(
          await trackService.release(conv, { discard: true }),
          'absent',
          'retention detaches the conversation, so discard by chat id no longer finds it'
        )

        // The explicit discard path a Tracks-panel action would use: the row is
        // addressed directly, because parked work has no conversation.
        const row = trackRepository.findByBranch(wsId, 'feat/abandoned')
        assert.ok(row)
        await trackService.discard(row.id)

        assert.equal(existsSync(target.path), false, 'an explicit discard really deletes')
        assert.equal(trackRepository.findByBranch(wsId, 'feat/abandoned'), undefined)
      })
    })

    test('a linked node_modules does not make every tree look dirty forever', async () => {
      await withRepo(async (_git, dir, wsId) => {
        // No .gitignore: without a targeted filter the symlink this service
        // creates shows up as `?? node_modules/`, so no tree is ever reclaimable.
        await mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/deps-only'
        })

        assert.equal(await trackService.release(conv), 'removed')
        assert.equal(existsSync(target.path), false)
      })
    })

    test('the reaper re-checks an interrupted removal instead of finishing it blindly', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/crashed-mid-teardown'
        })
        await writeFile(join(target.path, 'survivor.txt'), 'written before the crash\n')
        // Exactly the state a process death between markRemoving() and the git
        // call leaves behind. Trusting the tombstone would delete the file.
        trackRepository.markRemoving(trackRepository.findByOwner('chat', conv).id)

        await trackService.pruneOrphans()

        assert.ok(existsSync(join(target.path, 'survivor.txt')), 'boot must not destroy work')
        assert.equal(
          trackRepository.findByBranch(wsId, 'feat/crashed-mid-teardown').status,
          'retained'
        )
      })
    })

    test('retained work blocks its branch with an explanation, not a raw git error', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const a = seedConv(wsId)
        const b = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: a,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/parked'
        })
        await writeFile(join(target.path, 'wip.txt'), 'unfinished\n')
        await trackService.release(a)

        await assert.rejects(
          () =>
            trackService.ensure({
              conversationId: b,
              workspaceId: wsId,
              repoPath: dir,
              branchName: 'feat/parked'
            }),
          (err: Error) => {
            assert.ok(err instanceof TrackConflictError)
            // "another chat" would send the user hunting for a chat that was
            // deleted; the parked tree is what they actually need to find.
            assert.match(err.message, /retained work/)
            return true
          }
        )
      })
    })
  })

  // ── Visibility: idle reaping and adopting retained work ──────────────

  describe('TrackService — bounds and recovery', () => {
    test('reapIdle reclaims an idle CLEAN tree', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/idle-clean'
        })
        assert.ok(target.isolated)

        // Nothing has touched it for a fortnight.
        const row = trackRepository.findByOwner('chat', conv)
        db.prepare(
          "UPDATE work_tracks SET last_used_at = datetime('now', '-14 days') WHERE id = ?"
        ).run(row.id)

        // Asserted on this row rather than the return count: reapIdle sweeps
        // every workspace, and these tests run concurrently.
        await trackService.reapIdle()
        assert.equal(existsSync(target.path), false)
        assert.equal(trackRepository.findByOwner('chat', conv), undefined)
      })
    })

    test('reapIdle never touches an idle DIRTY tree, however old', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/idle-dirty'
        })
        await writeFile(join(target.path, 'unsaved.txt'), 'a day of work\n')

        const row = trackRepository.findByOwner('chat', conv)
        db.prepare(
          "UPDATE work_tracks SET last_used_at = datetime('now', '-99 days') WHERE id = ?"
        ).run(row.id)

        await trackService.reapIdle()
        assert.ok(
          existsSync(join(target.path, 'unsaved.txt')),
          '“probably done with it” is not consent to delete uncommitted work'
        )
        assert.ok(trackRepository.findByOwner('chat', conv))

        await trackService.release(conv, { discard: true })
      })
    })

    test('reapIdle leaves a recently used tree alone', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/fresh'
        })

        await trackService.reapIdle()
        assert.ok(existsSync(target.path), 'a tree used this turn is not idle')
        assert.ok(trackRepository.findByOwner('chat', conv))

        await trackService.release(conv)
      })
    })

    test('adopt hands retained work to a new chat — the same directory', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/recoverable'
        })
        await writeFile(join(target.path, 'draft.txt'), 'the work that must not vanish\n')

        // Chat closes with uncommitted changes — the tree is parked.
        assert.equal(await trackService.release(conv), 'retained')
        const parked = trackRepository.findByBranch(wsId, 'feat/recoverable')
        assert.equal(parked.ownerId, null)

        const newConvId = trackService.adopt(parked.id)
        assert.ok(newConvId, 'retained work must be reachable again')

        // Same directory, same uncommitted file — not a fresh checkout.
        const resolved = trackService.resolve(newConvId, dir)
        assert.equal(resolved.path, target.path)
        assert.equal(resolved.isolated, true)
        assert.equal(
          await readFile(join(resolved.path, 'draft.txt'), 'utf-8'),
          'the work that must not vanish\n'
        )

        await trackService.release(newConvId, { discard: true })
      })
    })

    test('adopt refuses a track that still has an owner', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/still-owned'
        })

        const row = trackRepository.findByOwner('chat', conv)
        assert.equal(
          trackService.adopt(row.id),
          null,
          'stealing a live tree would strand the chat that believes it holds it'
        )

        await trackService.release(conv)
      })
    })

    test('summarize reports dirty state and owner label per track', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/summarised'
        })
        await writeFile(join(target.path, 'wip.txt'), 'x\n')

        const [summary] = await trackService.summarize(wsId)
        assert.equal(summary.branchName, 'feat/summarised')
        assert.equal(summary.exists, true)
        assert.equal(summary.dirty, true)
        assert.ok(summary.diskBytes > 0)
        assert.ok(summary.ownerLabel, 'a chat owner resolves to its title')

        await trackService.release(conv, { discard: true })
      })
    })
  })

  // ── The one-writer rule for the shared primary tree ───────────────────

  describe('primaryTreeLock — one writer in the shared primary tree', () => {
    const chat = (id: string): Record<string, string> => ({
      ownerKind: 'chat',
      ownerId: id,
      reason: `Chat "${id}"`
    })
    const blueprint = (id: string): Record<string, string> => ({
      ownerKind: 'blueprint',
      ownerId: `blueprint:${id}`,
      reason: 'A blueprint BUILD phase'
    })

    test('only one owner may occupy a workspace’s primary tree', () => {
      assert.equal(primaryTreeLock.acquire('ws-lock-1', chat('conv-a')), true)
      assert.equal(
        primaryTreeLock.acquire('ws-lock-1', chat('conv-b')),
        false,
        'two branchless chats in one directory is the original bug'
      )
      assert.equal(primaryTreeLock.holder('ws-lock-1').ownerId, 'conv-a')

      primaryTreeLock.release('ws-lock-1', 'conv-a')
      assert.equal(primaryTreeLock.acquire('ws-lock-1', chat('conv-b')), true)
      primaryTreeLock.release('ws-lock-1', 'conv-b')
    })

    test('re-entrant for the same owner — a retried turn must not deadlock', () => {
      assert.equal(primaryTreeLock.acquire('ws-lock-2', chat('conv-a')), true)
      assert.equal(primaryTreeLock.acquire('ws-lock-2', chat('conv-a')), true)
      primaryTreeLock.release('ws-lock-2', 'conv-a')
    })

    test('a superseded turn’s late release cannot free its successor’s lock', () => {
      primaryTreeLock.acquire('ws-lock-3', chat('conv-a'))
      primaryTreeLock.release('ws-lock-3', 'conv-a')
      primaryTreeLock.acquire('ws-lock-3', chat('conv-b'))

      // conv-a's disposer fires late, after conv-b already took the tree.
      primaryTreeLock.release('ws-lock-3', 'conv-a')

      assert.equal(primaryTreeLock.holder('ws-lock-3').ownerId, 'conv-b')
      primaryTreeLock.release('ws-lock-3', 'conv-b')
    })

    test('locks are per workspace — unrelated projects never block each other', () => {
      assert.equal(primaryTreeLock.acquire('ws-lock-4', chat('conv-a')), true)
      assert.equal(primaryTreeLock.acquire('ws-lock-5', chat('conv-b')), true)
      primaryTreeLock.release('ws-lock-4', 'conv-a')
      primaryTreeLock.release('ws-lock-5', 'conv-b')
    })

    test('a blueprint run blocks a branchless chat turn, and vice versa', () => {
      assert.equal(primaryTreeLock.acquire('ws-lock-6', blueprint('bp-1')), true)
      assert.equal(
        primaryTreeLock.acquire('ws-lock-6', chat('conv-a')),
        false,
        'BUILD writes the user’s own checkout — a chat must not write it too'
      )
      primaryTreeLock.release('ws-lock-6', 'blueprint:bp-1')

      assert.equal(primaryTreeLock.acquire('ws-lock-6', chat('conv-a')), true)
      assert.equal(primaryTreeLock.acquire('ws-lock-6', blueprint('bp-1')), false)
      primaryTreeLock.release('ws-lock-6', 'conv-a')
    })

    test('BUILD→VERIFY is one continuous claim under one owner id', () => {
      // BUILD claims, then hands off without releasing; VERIFY re-acquires.
      assert.equal(primaryTreeLock.acquire('ws-lock-7', blueprint('bp-2')), true)
      assert.equal(
        primaryTreeLock.acquire('ws-lock-7', {
          ownerKind: 'blueprint',
          ownerId: 'blueprint:bp-2',
          reason: 'A blueprint VERIFY phase'
        }),
        true,
        'the handoff must not leave a gap another writer can take'
      )
      assert.equal(primaryTreeLock.holder('ws-lock-7').reason, 'A blueprint VERIFY phase')

      primaryTreeLock.release('ws-lock-7', 'blueprint:bp-2')
      assert.equal(primaryTreeLock.holder('ws-lock-7'), undefined)
    })

    test('non-chat holders do not emit a (blockedBy:) tag', () => {
      const chatBlocked = primaryTreeBusyError({
        ownerKind: 'chat',
        ownerId: 'conv-x',
        reason: 'Chat "x"'
      })
      assert.match(chatBlocked.message, /\(blockedBy:conv-x\)/)

      // A blueprint id in that tag renders as “another chat is still
      // processing” and offers to switch to a conversation that does not exist.
      const bpBlocked = primaryTreeBusyError({
        ownerKind: 'blueprint',
        ownerId: 'blueprint:bp-3',
        reason: 'A blueprint BUILD phase'
      })
      assert.equal(/blockedBy:/.test(bpBlocked.message), false)
      assert.match(bpBlocked.message, /blueprint BUILD phase/)
    })
  })

  // ── Path budget ───────────────────────────────────────────────────
  //
  // Windows MAX_PATH is 260 characters INCLUDING everything inside the tree.
  // The old layout spent ~140 of them before a single repository file, which
  // fails deep inside git with errors that point nowhere near here. These
  // assert the shape of the path rather than an exact string — the numbers are
  // a budget, not a contract.

  describe('worktree path length', () => {
    test('the leaf is bounded regardless of how long the branch name is', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName:
            'feat/an-extremely-long-branch-name-of-the-kind-generated-from-a-verbose-chat-title'
        })

        const leaf = target.path.slice(target.path.lastIndexOf('/') + 1)
        // 24-char branch slug + '-' + 8-char owner slug.
        assert.ok(leaf.length <= 33, `leaf is ${leaf.length} chars: ${leaf}`)

        await trackService.release(conv, { discard: true })
      })
    })

    test('the workspace segment is a short prefix, not the full 32-char id', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/short'
        })

        const segments = target.path.split('/')
        const wsSegment = segments[segments.length - 2]
        assert.ok(wsSegment.length <= 8, `workspace segment is ${wsSegment.length} chars`)
        assert.equal(wsSegment, wsId.slice(0, 8))

        await trackService.release(conv, { discard: true })
      })
    })

    test('an existing row keeps its stored path — the layout change is not retroactive', async () => {
      await withRepo(async (_git, dir, wsId) => {
        const conv = seedConv(wsId)
        const target = await trackService.ensure({
          conversationId: conv,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/stable-path'
        })

        // Whatever the current naming scheme is, resolve() must answer with the
        // path on the row rather than recomputing one — otherwise every track
        // created before a layout change is orphaned by it.
        const resolved = trackService.resolve(conv, dir)
        assert.equal(resolved.path, target.path)
        assert.equal(trackRepository.findByOwner('chat', conv).path, target.path)

        await trackService.release(conv, { discard: true })
      })
    })
  })

  // ── Periodic reaper ──────────────────────────────────────────────────
  //
  // The reaper only ran at boot, which made the seven-day idle policy a
  // function of restart frequency: leave the app open and nothing is ever
  // reclaimed. These pin the timer's lifecycle, not its schedule.

  describe('idle reaper timer', () => {
    test('starting twice installs only one timer', () => {
      trackService.startIdleReaper(60_000)
      const first = (trackService as unknown as { reapTimer: unknown }).reapTimer
      assert.ok(first)

      trackService.startIdleReaper(60_000)
      assert.equal((trackService as unknown as { reapTimer: unknown }).reapTimer, first)

      trackService.stopIdleReaper()
      assert.equal((trackService as unknown as { reapTimer: unknown }).reapTimer, null)
    })

    test('stopping when never started is a no-op', () => {
      trackService.stopIdleReaper()
      trackService.stopIdleReaper()
      assert.equal((trackService as unknown as { reapTimer: unknown }).reapTimer, null)
    })

    test('a tick runs reapIdle', async () => {
      let calls = 0
      const original = trackService.reapIdle.bind(trackService)
      trackService.reapIdle = async (): Promise<number> => {
        calls++
        return 0
      }
      try {
        trackService.startIdleReaper(5)
        await new Promise((r) => setTimeout(r, 40))
        trackService.stopIdleReaper()
        assert.ok(calls > 0, 'expected at least one periodic reap')
      } finally {
        trackService.reapIdle = original
        trackService.stopIdleReaper()
      }
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
