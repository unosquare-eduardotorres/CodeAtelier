/**
 * R046 — BUILD refuses to start when its branch is held by other work.
 *
 * The incident: a chat took `blueprint/data-agent-445eeb12` on 08-31 and never
 * gave it back. From then on BUILD fell back to the primary tree (checked out
 * on `main`) while the work — and the agents — lived in the chat's worktree.
 * Verification stat'd the phase's tree, found nothing, and failed a task whose
 * file was already written, committed and 86 KB on disk. Twice, for 754s of
 * model time, with the identical verdict both times: the split is re-created on
 * every run, so retrying is guaranteed to lose.
 *
 * The app already *detected* this. `blueprint-track` named the holder, named
 * both paths, and said in plain language that the output "will not join the
 * work on that branch" — at warn level, then ran the phase anyway. Chats refuse
 * this exact condition (`lentBranchRefusal`); blueprints got a log line.
 *
 * What is asserted here is the refusal: no agent spawned, no time burned, the
 * failure tagged environmental so the UI disables Retry, and the holder's id in
 * the message — the one fact the user has no way to see from the app.
 *
 * The other half of the contract (every OTHER primary-tree fallback must keep
 * running — auto-branching off, primary mode, no commits, checkout already on
 * the branch) is asserted in blueprint-track.test.ts, where the decision is
 * made. It cannot be asserted here: not refusing means running a real build.
 *
 * Run: tsx src/main/services/__tests__/blueprint-build-branch-held.test.ts
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import {
  attachTestDb,
  liveTestDb,
  reloadWithRealDeps
} from '../../db/repositories/__tests__/db-test-helper'

setupElectronStub()

const gitAvailable = spawnSync('git', ['--version']).status === 0
const dbContext = attachTestDb()

process.env.AGENT_STUDIO_WORKTREE_ROOT = join(tmpdir(), `bp-held-root-${process.pid}`)

if (!gitAvailable || !dbContext) {
  describe('BUILD refuses a held branch (skipped)', () => {
    test('requires git and a database', () => {}, {
      skipReason: !gitAvailable ? 'git is not available on PATH' : 'no DB'
    })
  })
} else {
  const db = (): import('better-sqlite3').Database => liveTestDb()

  // Repositories first, then services — see blueprint-track.test.ts. A service
  // first required under another file's repository mock keeps that mock in its
  // bindings, and this test asserts through the real phase records.
  const [, , , , blueprintTrackMod, , buildMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/blueprint.repository'),
    require.resolve('../track.service'),
    require.resolve('../blueprint-track'),
    require.resolve('../blueprint.service'),
    require.resolve('../blueprint-build.service')
  ]) as [
    unknown,
    unknown,
    unknown,
    typeof import('../track.service'),
    typeof import('../blueprint-track'),
    unknown,
    typeof import('../blueprint-build.service')
  ]
  const { trackService } = require('../track.service')
  const { blueprintTrackBranch } = blueprintTrackMod
  const { blueprintBuildService } = buildMod
  const {
    blueprintRepository,
    blueprintPhaseRepository
  } = require('../../db/repositories/blueprint.repository')

  let seq = 0

  /** Temp repo on `main` with one commit, plus workspace + blueprint + phases. */
  async function withBlueprint(
    fn: (ctx: { dir: string; wsId: string; bpId: string; title: string }) => Promise<void>
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'bp-held-'))
    const wsId = `bp-held-ws-${seq++}`
    const title = 'Add retry to uploads'
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
        .run(wsId, `BP held workspace ${wsId}`, dir)

      const bp = blueprintRepository.create({ workspaceId: wsId, title })
      blueprintPhaseRepository.createAllPhases(bp.id)

      await fn({ dir, wsId, bpId: bp.id, title })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  describe('R046 — a phase whose output cannot reach its branch does not start', () => {
    test('BUILD fails immediately, names the holder, and disables Retry', async () => {
      await withBlueprint(async ({ dir, wsId, bpId, title }) => {
        // A chat holds the branch this blueprint's work lives on — the 08-31
        // handoff, never reversed.
        const branch = blueprintTrackBranch(bpId, title)
        const chatOwner = `chat-holder-${bpId}`
        const held = await trackService.ensureTrack({
          ownerKind: 'chat',
          ownerId: chatOwner,
          workspaceId: wsId,
          repoPath: dir,
          branchName: branch
        })

        const startedAt = Date.now()
        await blueprintBuildService.startBuildPhase({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        const elapsed = Date.now() - startedAt

        const phase = blueprintPhaseRepository.findByBlueprintAndPhase(bpId, 'build')
        assert.equal(phase.status, 'failed', 'the phase refuses rather than running')
        assert.equal(
          blueprintRepository.findById(bpId)?.status,
          'failed',
          'and the blueprint is failed, not left building'
        )

        const snap = JSON.parse(phase.contextSnapshot) as Record<string, unknown>
        const environmental = String(snap.environmentalFailure ?? '')
        assert.ok(
          environmental,
          'the failure is environmental — deterministic, re-created on every run, so ' +
            'the UI must disable Retry rather than offer 3.5 more minutes of the same'
        )
        assert.ok(environmental.includes(branch), `names the branch — got: ${environmental}`)
        assert.ok(
          environmental.includes(chatOwner),
          'names the holder: the id is the one thing the user cannot get from the app'
        )
        assert.ok(environmental.includes(held.path), 'and the tree the work is actually in')

        // No agent was spawned: the whole point is that this costs nothing.
        assert.equal(
          phase.artifactsJson.filter((a: { type: string }) => a.type.startsWith('build')).length,
          0,
          'no build artifact — the phase never reached task execution'
        )
        assert.ok(elapsed < 30_000, `refusal is immediate — took ${elapsed}ms`)

        await trackService.releaseTrack('chat', chatOwner, { discard: true })
      })
    })

    test('the refusal is not auto-retried — the loop cannot converge', async () => {
      const { blueprintService } = require('../blueprint.service')
      const refusal =
        'Branch blueprint/x is held by chat:dea19fc2 at /wt/ce8325fc. This phase would run ' +
        'in the workspace checkout instead, so its output could never join that branch.'
      assert.equal(
        blueprintService.isRetryableError(refusal),
        false,
        'a deterministic environmental failure must never be scheduled for retry'
      )
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
