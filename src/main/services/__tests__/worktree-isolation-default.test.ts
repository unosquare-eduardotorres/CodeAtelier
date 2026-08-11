/**
 * Does isolation actually engage for a normally-created chat?
 *
 * The worktree machinery had fifteen passing tests and still did nothing in
 * practice, because two things upstream of it were wrong and the tests all
 * started by handing `ensure()` a branch name directly:
 *
 *  1. `gitAutoBranch` defaulted to off, so the default chat had
 *     `branchName = null` and `ensure()` correctly returned the shared tree.
 *     The mechanism was built and left unplugged.
 *
 *  2. Chat creation ran `git checkout` in the workspace root. That moved a HEAD
 *     shared by every running agent, AND parked the primary tree on the new
 *     branch — which sent `ensure()` down its "primary already holds this
 *     branch" path, so the chats that *did* ask for isolation were the ones
 *     most likely to be denied it.
 *
 * So these tests drive the real IPC handler against a real repo and assert on
 * the two things a unit test of `ensure()` structurally cannot see: where HEAD
 * ended up, and whether the resulting conversation is isolated.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub, invokeHandler, capturedHandlers } from './electron-stub'
import { attachTestDb } from '../../db/repositories/__tests__/db-test-helper'

setupElectronStub()

const gitAvailable = spawnSync('git', ['--version']).status === 0
const dbContext = attachTestDb()

process.env.AGENT_STUDIO_WORKTREE_ROOT = join(tmpdir(), `wt-default-root-${process.pid}`)

let registered = false
try {
  const mod = require('../../ipc/conversation-crud.ipc')
  mod.registerConversationCrudIpc()
  registered = true
} catch (err) {
  console.log(`⚠ conversation-crud.ipc.ts load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (!gitAvailable || !dbContext || !registered) {
  describe('branch-per-chat default (skipped)', () => {
    test('requires git, a database and the CRUD IPC module', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB / IPC unavailable'
    })
  })
} else {
  const { db } = dbContext
  const { trackService } = require('../track.service')

  let wsSeq = 0

  /**
   * Real repo on `main` with two commits' worth of history and a workspace row
   * pointing at it. `settings` is written verbatim so a test can express
   * "the user never touched this" (undefined) separately from "the user turned
   * it off" (false) — the whole point of the default flip.
   */
  async function withWorkspace(
    settings: Record<string, unknown>,
    fn: (dir: string, wsId: string) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'wt-default-'))
    try {
      const git = simpleGit(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Code Atelier Test')
      await git.addConfig('commit.gpgsign', 'false')
      await writeFile(join(dir, 'README.md'), '# base\n')
      await git.add('.')
      await git.commit('base')

      const wsId = `wt-def-ws-${wsSeq++}`
      db.prepare(
        'INSERT INTO workspaces (id, name, repo_path, settings_json) VALUES (?, ?, ?, ?)'
      ).run(wsId, `Default WS ${wsId}`, dir, JSON.stringify(settings))

      await fn(dir, wsId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const headOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD'])).trim()

  const localBranches = async (dir: string): Promise<string[]> =>
    (await simpleGit(dir).branchLocal()).all

  type Created = { id: string; branchName: string | null }

  const createChat = async (args: Record<string, unknown>): Promise<Created> =>
    (await invokeHandler('chat:createConversation', args)) as Created

  describe('chat creation — the primary HEAD is not a shared mutable', () => {
    test('registers chat:createConversation', () => {
      assert.ok(capturedHandlers.has('chat:createConversation'))
    })

    test('creating a chat creates the branch ref without checking it out', async () => {
      await withWorkspace({}, async (dir, wsId) => {
        const conv = await createChat({ workspaceId: wsId, title: 'Add retry logic' })

        assert.ok(conv.branchName, 'a chat with no branch cannot be isolated at all')
        assert.equal(
          await headOf(dir),
          'main',
          'creating a chat must not move a HEAD that other agents are writing through'
        )
        assert.ok(
          (await localBranches(dir)).includes(conv.branchName!),
          'the ref still has to exist — the worktree checks it out later'
        )
      })
    })

    test('creating a chat mid-stream cannot redirect the running agent', async () => {
      await withWorkspace({}, async (dir, wsId) => {
        // Stand in for a chat that is already streaming: it owns a branch and
        // is writing into its own tree.
        const busy = await createChat({ workspaceId: wsId, title: 'Long running work' })
        const busyTree = await trackService.ensure({
          conversationId: busy.id,
          workspaceId: wsId,
          repoPath: dir,
          branchName: busy.branchName
        })
        assert.equal(busyTree.isolated, true)

        await createChat({ workspaceId: wsId, title: 'Something else entirely' })

        assert.equal(
          await headOf(busyTree.path),
          busy.branchName,
          'the in-flight agent is still on its own branch'
        )
        assert.equal(await headOf(dir), 'main', 'and the shared tree never moved')

        await trackService.release(busy.id)
      })
    })

    test('a chat created while another streams still gets its own tree', async () => {
      await withWorkspace({}, async (dir, wsId) => {
        const first = await createChat({ workspaceId: wsId, title: 'First' })
        const firstTree = await trackService.ensure({
          conversationId: first.id,
          workspaceId: wsId,
          repoPath: dir,
          branchName: first.branchName
        })

        const second = await createChat({ workspaceId: wsId, title: 'Second' })
        const secondTree = await trackService.ensure({
          conversationId: second.id,
          workspaceId: wsId,
          repoPath: dir,
          branchName: second.branchName
        })

        // Under checkout-on-create the primary tree would be sitting on
        // `second`'s branch by now, and ensure() would have handed back the
        // shared directory with isolated: false.
        assert.equal(secondTree.isolated, true)
        assert.notEqual(secondTree.path, dir)
        assert.notEqual(secondTree.path, firstTree.path)

        await trackService.release(first.id)
        await trackService.release(second.id)
      })
    })
  })

  describe('chat creation — isolation is the default, opting out is explicit', () => {
    test('an untouched workspace setting means yes', async () => {
      await withWorkspace({}, async (_dir, wsId) => {
        const conv = await createChat({ workspaceId: wsId, title: 'Untouched settings' })
        assert.ok(conv.branchName, 'undefined gitAutoBranch used to mean no — that was the defect')
      })
    })

    test('the user asking to work on the current branch is honoured', async () => {
      await withWorkspace({}, async (dir, wsId) => {
        const conv = await createChat({
          workspaceId: wsId,
          title: 'On current branch please',
          autoBranch: false
        })

        assert.ok(!conv.branchName, 'the user said work here — nothing to isolate')
        assert.equal(
          (await localBranches(dir)).length,
          1,
          'opting out must not leave a stray branch behind'
        )
      })
    })

    test('a workspace that deliberately turned auto-branch off is honoured', async () => {
      await withWorkspace({ gitAutoBranch: false }, async (_dir, wsId) => {
        const conv = await createChat({ workspaceId: wsId, title: 'Workspace opted out' })
        assert.ok(!conv.branchName, 'a deliberate false is still respected')
      })
    })

    test('an explicit branch name overrides a workspace opt-out', async () => {
      await withWorkspace({ gitAutoBranch: false }, async (dir, wsId) => {
        const conv = await createChat({
          workspaceId: wsId,
          title: 'Explicit pick',
          branchName: 'feat/user-chose-this'
        })

        assert.equal(conv.branchName, 'feat/user-chose-this')
        assert.ok((await localBranches(dir)).includes('feat/user-chose-this'))
        assert.equal(await headOf(dir), 'main')
      })
    })

    test('picking an existing branch reuses the ref instead of failing', async () => {
      await withWorkspace({}, async (dir, wsId) => {
        await simpleGit(dir).raw(['branch', 'feat/already-there'])

        const conv = await createChat({
          workspaceId: wsId,
          title: 'Reuse',
          branchName: 'feat/already-there'
        })

        assert.equal(conv.branchName, 'feat/already-there')
        assert.equal(await headOf(dir), 'main')
      })
    })

    test('the source branch is still recorded for the eventual PR base', async () => {
      await withWorkspace({}, async (_dir, wsId) => {
        const conv = (await createChat({ workspaceId: wsId, title: 'PR base' })) as Created & {
          sourceBranch?: string
        }
        assert.equal(conv.sourceBranch, 'main')
      })
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
