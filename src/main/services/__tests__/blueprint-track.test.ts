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
  const [trackRepoMod, , , trackMod, blueprintTrackMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/blueprint.repository'),
    require.resolve('../track.service'),
    require.resolve('../blueprint-track')
  ]) as [
    typeof import('../../db/repositories/track.repository'),
    unknown,
    unknown,
    typeof import('../track.service'),
    typeof import('../blueprint-track')
  ]
  const { trackRepository } = trackRepoMod
  const { trackService, registerTrackBusyProbe } = trackMod
  const {
    ensureBlueprintTrack,
    resolveBlueprintTrack,
    reserveBlueprintBranch,
    resolveBlueprintBase,
    blueprintTrackBranch,
    blueprintTrackOwner,
    findHandoffHolder,
    branchHeldElsewhereError
  } = blueprintTrackMod
  const { FOLLOW_CHECKOUT } = require('../../../shared/constants')
  const { verifyTaskFileClaims } = require('../blueprint-task-verification')

  /**
   * Which chat owners count as mid-turn, keyed by owner id.
   *
   * A single mutable flag would be a race — this harness runs tests
   * concurrently — so busyness is keyed on the owner id, which is unique per
   * test and is exactly what the probe is handed.
   */
  const busyChats = new Map<string, string>()
  registerTrackBusyProbe('chat', (ownerId) => busyChats.get(ownerId) ?? null)

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

  /** Persist a branch choice the way the create modal does. */
  function setBranchChoice(bpId: string, choice: Record<string, unknown>): void {
    db()
      .prepare('UPDATE blueprints SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify({ branchChoice: choice }), bpId)
  }

  /** Overwrite a blueprint's whole settings blob. */
  function setSettings(bpId: string, settings: Record<string, unknown>): void {
    db()
      .prepare('UPDATE blueprints SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(settings), bpId)
  }

  function readSettings(bpId: string): Record<string, unknown> {
    const row = db().prepare('SELECT settings_json FROM blueprints WHERE id = ?').get(bpId) as {
      settings_json: string | null
    }
    return row.settings_json ? JSON.parse(row.settings_json) : {}
  }

  const localBranches = async (dir: string): Promise<string[]> =>
    (await simpleGit(dir).branchLocal()).all

  const headOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).revparse(['--abbrev-ref', 'HEAD'])).trim()

  const statusOf = async (dir: string): Promise<string> =>
    (await simpleGit(dir).raw(['status', '--porcelain'])).trim()

  /** Write a workspace's settings blob, the way the settings tab does. */
  function setWorkspaceSettings(wsId: string, settings: Record<string, unknown>): void {
    db()
      .prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?')
      .run(JSON.stringify(settings), wsId)
  }

  /**
   * Put a commit on `branch`, creating it from `from`, and return HEAD to where
   * it started. The checkout is restored on purpose: the whole question these
   * tests ask is whether the resolved base survives HEAD moving.
   */
  async function commitOnBranch(
    dir: string,
    branch: string,
    from = 'main',
    file = `${branch.replace(/\W+/g, '-')}.md`
  ): Promise<void> {
    const git = simpleGit(dir)
    const back = await headOf(dir)
    await git.raw(['checkout', '-B', branch, from])
    await writeFile(join(dir, file), `${branch}\n`)
    await git.add('.')
    await git.commit(`work on ${branch}`)
    if (back && back !== 'HEAD') await git.checkout(back)
  }

  /**
   * Make `origin/<branch>` exist, pointing wherever `at` does.
   *
   * This is what a fetch leaves behind, and it is all the remote-base code ever
   * reads — nothing here clones or talks to a network, because nothing in
   * production does either: the refs are used exactly as they sit on disk.
   * `origin` is registered as a remote so `getRemotes` returns it, which is how
   * `origin/x` is recognised as a remote-tracking ref rather than a branch
   * somebody happened to name with a slash in it.
   */
  async function fetchedInto(dir: string, branch: string, at: string): Promise<void> {
    const git = simpleGit(dir)
    const remotes = await git.getRemotes(false)
    if (!remotes.some((r) => r.name === 'origin')) await git.addRemote('origin', dir)
    await git.raw(['update-ref', `refs/remotes/origin/${branch}`, at])
  }

  /**
   * The state remote bases exist for: `origin/main` a commit ahead of local
   * `main`, with the checkout left on `main`. Returns the origin tip.
   */
  async function originAheadOfMain(dir: string): Promise<string> {
    await commitOnBranch(dir, 'upstream', 'main', 'landed-upstream.md')
    const tip = (await simpleGit(dir).revparse(['upstream'])).trim()
    await fetchedInto(dir, 'main', 'upstream')
    // The local branch that carried the commit is deleted so nothing but the
    // remote-tracking ref can be the source of a passing assertion.
    await simpleGit(dir).raw(['branch', '-D', 'upstream'])
    return tip
  }

  /** The `auto` choice every blueprint gets when the user says nothing. */
  const AUTO = { mode: 'auto' as const }

  // ── Branch selection ──────────────────────────────────────────

  describe('blueprint branch selection', () => {
    test('fork branches from a chat’s branch while the chat is still holding it', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // A chat with its own tree, one commit ahead of main.
        const chatOwner = `chat-fork-${wsId}`
        const chat = await trackService.ensureTrack({
          ownerKind: 'chat',
          ownerId: chatOwner,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/chat-work',
          baseBranch: 'main'
        })
        await writeFile(join(chat.path, 'from-chat.txt'), 'chat wrote this\n')
        const chatGit = simpleGit(chat.path)
        await chatGit.add('.')
        await chatGit.commit('chat work')

        setBranchChoice(bpId, { mode: 'fork', branch: 'feat/chat-work' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        // Both run in parallel: git happily forks a branch that is checked out
        // elsewhere. A regression here would be silent, hence the assertion.
        assert.equal(target.isolated, true)
        assert.equal(target.reason, null)
        assert.notEqual(target.path, chat.path, 'the fork gets its own tree')
        assert.ok(
          existsSync(join(target.path, 'from-chat.txt')),
          'the fork starts from the base it was told to, not from main'
        )
        assert.ok(existsSync(chat.path), 'the chat keeps its tree')

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
        await trackService.releaseTrack('chat', chatOwner, { discard: true })
      })
    })

    test('takeover moves the chat’s tree across, uncommitted work included', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const chatOwner = `chat-take-${wsId}`
        const chat = await trackService.ensureTrack({
          ownerKind: 'chat',
          ownerId: chatOwner,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/handover',
          baseBranch: 'main'
        })
        // Deliberately NOT committed: the promise of a handoff is that the new
        // owner sees what the previous one left, not a clean checkout.
        await writeFile(join(chat.path, 'half-done.txt'), 'mid-thought\n')

        setBranchChoice(bpId, { mode: 'takeover', branch: 'feat/handover' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, true)
        assert.equal(target.reason, null)
        assert.equal(target.path, chat.path, 'the SAME directory changes hands')
        assert.equal(target.branchName, 'feat/handover')
        assert.ok(existsSync(join(target.path, 'half-done.txt')), 'uncommitted work came with it')

        // One track, now owned by the blueprint — not a second row.
        assert.equal(trackRepository.findByOwner('chat', chatOwner), undefined)
        const owned = trackRepository.findByOwner('blueprint', bpId)
        assert.ok(owned)
        assert.equal(owned.path, chat.path)

        // ...and it can be handed back the same way.
        const back = trackService.transferOwner(owned.id, {
          ownerKind: 'chat',
          ownerId: chatOwner
        })
        assert.equal(back.ok, true)
        assert.equal(trackRepository.findByOwner('chat', chatOwner)?.path, chat.path)

        await trackService.releaseTrack('chat', chatOwner, { discard: true })
      })
    })

    test('takeover is refused while the holder is mid-turn, and says who', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const chatOwner = `chat-busy-${wsId}`
        await trackService.ensureTrack({
          ownerKind: 'chat',
          ownerId: chatOwner,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/busy',
          baseBranch: 'main'
        })
        busyChats.set(chatOwner, 'it is streaming a reply right now')

        setBranchChoice(bpId, { mode: 'takeover', branch: 'feat/busy' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        // Degraded, never thrown — BUILD must not die because a branch was busy.
        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.match(target.reason ?? '', /feat\/busy/)
        assert.match(target.reason ?? '', /streaming a reply/)

        // ...and the holder comes back as data, not only as prose: BUILD refuses
        // on this field, and the message it prints names the chat to go and end.
        assert.equal(target.heldBy?.branchName, 'feat/busy')
        assert.equal(target.heldBy?.ownerKind, 'chat')
        assert.equal(target.heldBy?.ownerId, chatOwner)

        // The chat still owns its tree; nothing was taken.
        assert.ok(trackRepository.findByOwner('chat', chatOwner))
        assert.equal(trackRepository.findByOwner('blueprint', bpId), undefined)

        busyChats.delete(chatOwner)
        await trackService.releaseTrack('chat', chatOwner, { discard: true })
      })
    })

    test('taking over the branch the checkout is on runs in the primary tree, and says so', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // The primary tree is on `main`, and git allows a branch in one worktree.
        setBranchChoice(bpId, { mode: 'takeover', branch: 'main' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.match(
          target.reason ?? '',
          /already on main/,
          'the user asked for a branch and is getting the shared tree — that must be stated'
        )
        assert.equal(
          target.heldBy,
          undefined,
          'the checkout IS on the branch, so writes here do join it — this must keep running'
        )
      })
    })

    test('primary mode runs in the workspace checkout without creating anything', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        setBranchChoice(bpId, { mode: 'primary' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.match(target.reason ?? '', /workspace checkout/)
        assert.equal(target.heldBy, undefined, 'a deliberate choice is not a split brain')
        assert.equal(trackRepository.findByOwner('blueprint', bpId), undefined)
      })
    })

    test('a repository with no commits degrades to the primary tree rather than throwing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bp-empty-'))
      const wsId = `bp-empty-ws-${seq++}`
      try {
        // init only — an unborn HEAD, which is what a brand-new project is.
        await simpleGit(dir).init(['--initial-branch=main'])
        db()
          .prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
          .run(wsId, `Empty workspace ${wsId}`, dir)
        const bp = db()
          .prepare(
            `INSERT INTO blueprints (workspace_id, title, description)
             VALUES (?, ?, ?) RETURNING id`
          )
          .get(wsId, 'Scaffold a new project', 'desc') as { id: string }

        // `auto` — the default. Nothing was picked, and it must still not throw.
        const target = await ensureBlueprintTrack({
          blueprintId: bp.id,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.match(target.reason ?? '', /no commits yet/)
        assert.equal(target.heldBy, undefined, 'nothing holds a branch that does not exist')
        assert.equal(trackRepository.findByOwner('blueprint', bp.id), undefined)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  // ── Base resolution ────────────────────────────────────
  //
  // The chain is resolve-then-upgrade: a base wins outright, and only then is
  // `integration/<it>` substituted. Ordering it the other way — ranking the
  // integration branch above the workspace setting — reads the live checkout to
  // derive its candidate, so switching branches would silently override a pin.
  // The pair of tests that would fail under that ordering are marked below.

  describe('resolving the base a blueprint forks from', () => {
    test('with nothing configured, follows the checkout — unchanged for every existing workspace', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        await simpleGit(dir).checkout('feat/x')

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'feat/x')
        assert.equal(base.source, 'checkout')
        assert.equal(base.upgradedToIntegration, false)
        assert.ok(base.commit, 'a real base resolves to a real commit')
      })
    })

    test('the follow-checkout sentinel is treated exactly as absence', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        await simpleGit(dir).checkout('feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: FOLLOW_CHECKOUT })

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'feat/x')
        assert.equal(base.source, 'checkout')
      })
    })

    // AC2. Fails under the doc's original precedence.
    test('a pinned base outranks the checkout, and moving the checkout does not change it', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        const onMain = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: AUTO
        })
        await simpleGit(dir).checkout('feat/x')
        const onFeature = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: AUTO
        })

        assert.equal(onMain.branch, 'main')
        assert.equal(onFeature.branch, 'main', 'the pin survives a checkout switch')
        assert.equal(onFeature.source, 'workspace-setting')
      })
    })

    // AC2 + AC5 together — the pair the doc's own precedence could not satisfy.
    // Under "integration branch beats the setting", the candidate would be
    // integration/feat/x (derived from the live checkout) and the pin lost.
    test('the integration branch upgrades the PINNED base, not the checked-out one', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        await commitOnBranch(dir, 'integration/main', 'main')
        await commitOnBranch(dir, 'integration/feat/x', 'feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })
        await simpleGit(dir).checkout('feat/x')

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'integration/main')
        assert.equal(base.resolvedFrom, 'main', 'the pin is what got upgraded')
        assert.equal(base.source, 'workspace-setting', 'the upgrade is a modifier, not a rule')
        assert.equal(base.upgradedToIntegration, true)
        assert.equal(base.aheadOfResolved, 1)
      })
    })

    test('an integration branch level with its base is not used — it carries nothing', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await simpleGit(dir).raw(['branch', 'integration/main', 'main'])

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'main')
        assert.equal(base.upgradedToIntegration, false)
        assert.equal(base.aheadOfResolved, 0)
      })
    })

    // R5.
    test('a pinned base that no longer exists falls through to the next rule, not to main', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        await simpleGit(dir).checkout('feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'release/deleted' })

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'feat/x', 'the checkout is the next rule, main is the last one')
        assert.equal(base.source, 'checkout')
      })
    })

    // Precedence rule 1.
    test('an explicit fork choice outranks the workspace pin', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await commitOnBranch(dir, 'feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'feat/x' }
        })

        assert.equal(base.branch, 'feat/x')
        assert.equal(base.source, 'blueprint-fork')
      })
    })

    // R8.
    test('a detached HEAD falls to the repository default rather than guessing main', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        const git = simpleGit(dir)
        // A repo whose mainline is `develop`, recorded the way `git clone` does.
        await commitOnBranch(dir, 'develop')
        await git.raw(['update-ref', 'refs/remotes/origin/develop', 'develop'])
        await git.raw(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
        await git.addRemote('origin', dir)
        await git.raw(['checkout', '--detach', 'HEAD'])

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.branch, 'develop')
        assert.equal(base.source, 'repo-default')
      })
    })

    test('a ref shaped like an option is refused rather than handed to git', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        setWorkspaceSettings(wsId, { blueprintBaseBranch: '--upload-pack=touch /tmp/pwn' })

        const base = await resolveBlueprintBase({ workspaceId: wsId, repoPath: dir, choice: AUTO })

        assert.equal(base.source, 'checkout')
        assert.equal(base.branch, 'main')
      })
    })

    // ── Remote fork points ──
    //
    // A remote ref plays two roles that must not be conflated: the fork point
    // (which has to stay `origin/main`, or picking it achieved nothing) and the
    // recorded base (which has to become local `main`, or the run lands in an
    // `integration/origin/main` no other run will ever look at).

    test('forking from origin/main keeps origin/main as the fork point', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        const originTip = await originAheadOfMain(dir)

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/main' }
        })

        assert.equal(base.branch, 'origin/main', 'normalising here would fork from the stale tip')
        assert.equal(base.commit, originTip)
        assert.equal(base.isRemote, true)
        assert.equal(base.source, 'blueprint-fork')
      })
    })

    test('...while recording the local counterpart as the base', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        await originAheadOfMain(dir)

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/main' }
        })

        assert.equal(base.integrationBase, 'main')
      })
    })

    test('a remote with no local counterpart keeps its own name as the base', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        // Never checked out locally, which is the ordinary state of a colleague's
        // branch. There is nothing to substitute, so nothing is.
        await commitOnBranch(dir, 'their-work', 'main', 'theirs.md')
        await fetchedInto(dir, 'feature-x', 'their-work')
        await simpleGit(dir).raw(['branch', '-D', 'their-work'])

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/feature-x' }
        })

        assert.equal(base.branch, 'origin/feature-x')
        assert.equal(base.integrationBase, 'origin/feature-x')
        assert.equal(base.isRemote, true)
      })
    })

    test('a local branch merely NAMED origin/x is not mistaken for a remote', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        // Legal, and people do it. Rewriting this to `weird` would fork from a
        // different branch than the one the user picked.
        await commitOnBranch(dir, 'weird', 'main', 'weird.md')
        await commitOnBranch(dir, 'origin/weird', 'main', 'named-like-a-remote.md')

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/weird' }
        })

        assert.equal(base.branch, 'origin/weird')
        assert.equal(base.integrationBase, 'origin/weird', 'no local counterpart was substituted')
        assert.equal(base.isRemote, false)
      })
    })

    test('the integration upgrade follows the LOCAL counterpart of a remote base', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        // The accumulation guarantee at resolution level: `integration/main` is
        // where landed work lives, and picking `origin/main` must still find it
        // rather than looking for an `integration/origin/main` that never exists.
        await originAheadOfMain(dir)
        await commitOnBranch(dir, 'integration/main', 'main', 'already-landed.md')

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/main' }
        })

        assert.equal(base.branch, 'integration/main')
        assert.equal(base.upgradedToIntegration, true)
        assert.equal(base.resolvedFrom, 'origin/main')
        assert.equal(base.integrationBase, 'integration/main', 'it is its own landing target')
        assert.equal(base.isRemote, false, 'the upgraded branch is local')
      })
    })

    test('an integration branch NOT ahead of the remote base is still not used', async () => {
      await withBlueprint(async ({ dir, wsId }) => {
        // `integration/main` level with local `main` is behind `origin/main`, so
        // forking from it would throw away the commits the remote was picked for.
        await simpleGit(dir).raw(['branch', 'integration/main', 'main'])
        await originAheadOfMain(dir)

        const base = await resolveBlueprintBase({
          workspaceId: wsId,
          repoPath: dir,
          choice: { mode: 'fork', branch: 'origin/main' }
        })

        assert.equal(base.branch, 'origin/main')
        assert.equal(base.upgradedToIntegration, false)
        assert.equal(base.integrationBase, 'main')
      })
    })
  })

  // ── Provenance ─────────────────────────────────────────

  describe('the base a run actually used is recorded on its track', () => {
    test('reservation cuts the branch from the pinned base, not from HEAD', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        await commitOnBranch(dir, 'feat/x')
        await simpleGit(dir).checkout('feat/x')
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.ok(name)

        const git = simpleGit(dir)
        const tip = (await git.revparse([name as string])).trim()
        const mainTip = (await git.revparse(['main'])).trim()
        const featTip = (await git.revparse(['feat/x'])).trim()
        assert.equal(tip, mainTip, 'forked from the pin')
        assert.notEqual(tip, featTip, 'not from the checkout it happened to be on')
      })
    })

    // Every test below reserves BEFORE building, because that is the only
    // ordering production ever uses: `blueprint.ipc.ts` reserves the branch
    // before SPECIFY, so by the time BUILD runs the ref always exists. Calling
    // `ensureBlueprintTrack` on a repo with no reservation tests a path no real
    // run takes — and it is exactly what hid the bug these tests now cover.
    async function reserveThenBuild(
      dir: string,
      wsId: string,
      bpId: string,
      between?: () => Promise<void>
    ): Promise<{ name: string; target: { isolated: boolean; path: string } }> {
      const name = await reserveBlueprintBranch({
        blueprintId: bpId,
        workspaceId: wsId,
        workspacePath: dir
      })
      assert.ok(name, 'the reservation must create the branch, as it does in production')
      await between?.()
      const target = await ensureBlueprintTrack({
        blueprintId: bpId,
        workspaceId: wsId,
        workspacePath: dir
      })
      return { name: name as string, target }
    }

    const tipOf = async (dir: string, ref: string): Promise<string> =>
      (await simpleGit(dir).revparse([ref])).trim()

    test('BUILD records the rule that chose the base, not that the branch existed', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        const mainTip = await tipOf(dir, 'main')
        const { name, target } = await reserveThenBuild(dir, wsId, bpId)
        assert.equal(target.isolated, true)

        // The branch was already exactly at the base, so nothing should have
        // moved — a reconcile that rewinds an untouched branch is still a bug.
        assert.equal(await tipOf(dir, name), mainTip, 'nothing was rewound')

        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseBranch, 'main')
        assert.equal(track?.baseSource, 'workspace-setting')
        assert.equal(track?.baseCommit, mainTip)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    // The defect this whole reconciliation exists for. The branch is cut at run
    // start; BUILD arrives phases later, and the base has moved on. Without the
    // fast-forward, `worktree add` uses the branch's stale tip while the row
    // records the current base name — git and the database disagreeing.
    test('a base that advanced during the earlier phases is picked up at BUILD', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        const { name, target } = await reserveThenBuild(dir, wsId, bpId, async () => {
          // Somebody merges to main while SPECIFY→TASKS run. The intervening
          // phases write artifacts to the DB, never to the branch, so the
          // blueprint branch still has no commits of its own.
          await commitOnBranch(dir, 'main', 'main', 'landed-while-planning.md')
        })

        const mainTip = await tipOf(dir, 'main')
        assert.equal(target.isolated, true)
        assert.equal(await tipOf(dir, name), mainTip, 'the branch was fast-forwarded to the base')
        assert.ok(
          existsSync(join(target.path, 'landed-while-planning.md')),
          'BUILD actually works on top of the newer base, not just records it'
        )

        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseSource, 'workspace-setting', 'the real rule, not existing-branch')
        assert.equal(track?.baseCommit, mainTip)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    // The other half: a branch carrying work is never moved, whatever the base
    // has done since. `existing-branch` is then the honest record — the base
    // really was not consulted — and a base commit would be a lie.
    test('a branch with commits of its own is left alone and records existing-branch', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        setWorkspaceSettings(wsId, { blueprintBaseBranch: 'main' })

        let ownTip = ''
        const { name, target } = await reserveThenBuild(dir, wsId, bpId, async () => {
          const reserved = readSettings(bpId).branchName as string
          await commitOnBranch(dir, reserved, reserved, 'own-work.md')
          ownTip = await tipOf(dir, reserved)
          await commitOnBranch(dir, 'main', 'main', 'landed-while-planning.md')
        })

        assert.equal(target.isolated, true)
        assert.equal(await tipOf(dir, name), ownTip, 'the branch keeps its own tip')
        assert.ok(
          existsSync(join(target.path, 'own-work.md')),
          'and the tree it gets is that branch, not the base'
        )

        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseSource, 'existing-branch')
        assert.equal(track?.baseCommit, null, 'no base commit, because no base was used')

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    // ── Remote fork points, end to end ──

    test('a run forked from origin/main is CUT from the origin tip', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const originTip = await originAheadOfMain(dir)
        const mainTip = await tipOf(dir, 'main')
        setBranchChoice(bpId, { mode: 'fork', branch: 'origin/main' })

        const { name, target } = await reserveThenBuild(dir, wsId, bpId)

        assert.equal(target.isolated, true)
        assert.equal(await tipOf(dir, name), originTip, 'forked from the remote, as asked')
        assert.notEqual(originTip, mainTip, 'the local branch really was behind')
        assert.ok(
          existsSync(join(target.path, 'landed-upstream.md')),
          'and the tree BUILD gets contains the upstream work, not just a ref that names it'
        )

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('...and RECORDS the local counterpart, with the origin tip as its base commit', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const originTip = await originAheadOfMain(dir)
        setBranchChoice(bpId, { mode: 'fork', branch: 'origin/main' })

        await reserveThenBuild(dir, wsId, bpId)

        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseBranch, 'main', 'the name landing derives its target from')
        assert.equal(track?.baseSource, 'blueprint-fork')
        // Nothing is lost by recording the local NAME: the commit column still
        // pins the exact origin tip the run was actually cut from.
        assert.equal(track?.baseCommit, originTip)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('a run forked from origin/main lands in integration/main, not integration/origin/main', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // The accumulation guarantee, asserted where it actually breaks. Landing
        // reads `baseBranch` off the row and derives its target from it, so a row
        // saying `origin/main` would send this run to a branch of its own that no
        // other run — and no promotion to mainline — will ever look at.
        await originAheadOfMain(dir)
        setBranchChoice(bpId, { mode: 'fork', branch: 'origin/main' })

        await reserveThenBuild(dir, wsId, bpId)

        const track = trackRepository.findByOwner('blueprint', bpId)
        const { integrationBranchFor } = require('../landing.service')
        assert.equal(integrationBranchFor(track?.baseBranch as string), 'integration/main')

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('a remote with no local counterpart is recorded under its own name', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        await commitOnBranch(dir, 'their-work', 'main', 'theirs.md')
        const theirTip = await tipOf(dir, 'their-work')
        await fetchedInto(dir, 'feature-x', 'their-work')
        await simpleGit(dir).raw(['branch', '-D', 'their-work'])
        setBranchChoice(bpId, { mode: 'fork', branch: 'origin/feature-x' })

        const { name } = await reserveThenBuild(dir, wsId, bpId)

        assert.equal(await tipOf(dir, name), theirTip)
        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseBranch, 'origin/feature-x', 'there was nothing to substitute')
        assert.equal(track?.baseCommit, theirTip)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('a takeover records existing-branch — it continues a branch, it forks nothing', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        await commitOnBranch(dir, 'feat/handover')
        setBranchChoice(bpId, { mode: 'takeover', branch: 'feat/handover' })

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(target.isolated, true)

        const track = trackRepository.findByOwner('blueprint', bpId)
        assert.equal(track?.baseSource, 'existing-branch')
        assert.equal(track?.baseCommit, null)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })
  })

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

  // ── Reservation at start ───────────────────────────────────────────
  //
  // The branch used to appear at BUILD, three phases after the user pressed
  // Start, so for most of a run there was no answer to "where is this going?".

  describe('reserving the branch when the run starts', () => {
    test('creates the ref without moving the checkout, and persists the name', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(name, blueprintTrackBranch(bpId, 'Add retry to uploads'))
        assert.ok((await localBranches(dir)).includes(name as string), 'the ref exists')
        assert.equal(await headOf(dir), 'main', 'the shared HEAD did not move')
        assert.equal(await statusOf(dir), '', 'nothing was checked out')
        assert.equal(readSettings(bpId).branchName, name)
      })
    })

    test('a Jira blueprint is named after its ticket', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        db()
          .prepare('UPDATE blueprints SET title = ? WHERE id = ?')
          .run('MUL-2336: Rename hotel billing detail', bpId)
        setSettings(bpId, { jiraIssueKey: 'MUL-2336' })

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(name, 'feature/MUL-2336-rename-hotel-billing-detail')
        assert.ok((await localBranches(dir)).includes(name as string))
        // The key must survive the round-trip through settings_json.
        assert.equal(readSettings(bpId).jiraIssueKey, 'MUL-2336')
      })
    })

    test('is idempotent — a second call keeps the name already reserved', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const first = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        const second = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(second, first)
      })
    })

    test('fork cuts the ref from the branch that was chosen, not from HEAD', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const git = simpleGit(dir)
        // release/1.0 stays at the first commit while main moves on, so "cut
        // from the right base" is actually observable.
        await git.raw(['branch', 'release/1.0'])
        await writeFile(join(dir, 'later.txt'), 'main moved on\n')
        await git.add('.')
        await git.commit('main moves ahead')

        setBranchChoice(bpId, { mode: 'fork', branch: 'release/1.0' })

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.ok(name)
        assert.equal(
          (await git.revparse([name as string])).trim(),
          (await git.revparse(['release/1.0'])).trim()
        )
        assert.notEqual(
          (await git.revparse([name as string])).trim(),
          (await git.revparse(['main'])).trim()
        )
      })
    })

    test('takeover reserves the branch it inherits, creating nothing new', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        await simpleGit(dir).raw(['branch', 'feat/existing'])
        setBranchChoice(bpId, { mode: 'takeover', branch: 'feat/existing' })
        const before = await localBranches(dir)

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(name, 'feat/existing')
        assert.deepEqual(await localBranches(dir), before, 'no new ref was created')
        assert.equal(readSettings(bpId).branchName, 'feat/existing')
      })
    })

    test('a name already in use is disambiguated rather than fought over', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        db().prepare('UPDATE blueprints SET title = ? WHERE id = ?').run('MUL-7: Fix billing', bpId)
        setSettings(bpId, { jiraIssueKey: 'MUL-7' })
        await simpleGit(dir).raw(['branch', 'feature/MUL-7-fix-billing'])

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(name, 'feature/MUL-7-fix-billing-2')
      })
    })

    test('the name reserved at start survives a later title rewrite', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        const reserved = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        // Specify routinely rewrites the title. Recomputing the name from it
        // would hand `ensureTrack` a different branch for the same owner, which
        // it reads as a stale track and rebuilds somewhere else.
        db()
          .prepare('UPDATE blueprints SET title = ? WHERE id = ?')
          .run('Something Specify decided to call it instead', bpId)

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, true)
        assert.equal(target.branchName, reserved)

        await trackService.releaseTrack('blueprint', bpId, { discard: true })
      })
    })

    test('reserves nothing when the workspace opted out of auto-branching', async () => {
      await withBlueprint(
        async ({ dir, wsId, bpId }) => {
          const before = await localBranches(dir)
          const name = await reserveBlueprintBranch({
            blueprintId: bpId,
            workspaceId: wsId,
            workspacePath: dir
          })
          assert.equal(name, null)
          assert.deepEqual(await localBranches(dir), before)
          assert.equal(readSettings(bpId).branchName, undefined)
        },
        { gitAutoBranch: false }
      )
    })

    test('reserves nothing when the blueprint runs in the workspace checkout', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        setBranchChoice(bpId, { mode: 'primary' })
        const before = await localBranches(dir)

        const name = await reserveBlueprintBranch({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(name, null)
        assert.deepEqual(await localBranches(dir), before)
      })
    })

    test('a repository with no commits reserves nothing rather than throwing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bp-reserve-empty-'))
      const wsId = `bp-reserve-ws-${seq++}`
      try {
        await simpleGit(dir).init(['--initial-branch=main'])
        db()
          .prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
          .run(wsId, `Empty workspace ${wsId}`, dir)
        const bp = db()
          .prepare(
            `INSERT INTO blueprints (workspace_id, title, description)
             VALUES (?, ?, ?) RETURNING id`
          )
          .get(wsId, 'Scaffold a new project', 'desc') as { id: string }

        const name = await reserveBlueprintBranch({
          blueprintId: bp.id,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(name, null)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    test('a missing workspace degrades to null instead of failing the run', async () => {
      const name = await reserveBlueprintBranch({
        blueprintId: 'no-such-blueprint',
        workspaceId: 'no-such-workspace',
        workspacePath: join(tmpdir(), 'definitely-not-a-repo')
      })
      assert.equal(name, null)
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
          assert.equal(
            target.heldBy,
            undefined,
            'opting out is not a split brain — BUILD must still run'
          )
        },
        { gitAutoBranch: false }
      )
    })

    test('a branch already held by other work degrades, and names the holder', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // Somebody else owns the branch this blueprint wants.
        const branch = blueprintTrackBranch(bpId, 'Add retry to uploads')
        const squatter = await trackService.ensureTrack({
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

        // R046: the fallback itself was never the bug — running anyway was. The
        // holder has to come back as data so BUILD can refuse on it.
        assert.equal(target.heldBy?.branchName, branch)
        assert.equal(target.heldBy?.ownerKind, 'manual')
        assert.equal(target.heldBy?.ownerId, `squatter-${bpId}`)
        assert.equal(target.heldBy?.path, squatter.path, 'names the tree the writes belong in')

        await trackService.releaseTrack('manual', `squatter-${bpId}`, { discard: true })
      })
    })

    test('R046: a branch handed to a chat is reported held, not silently shared', async () => {
      await withBlueprint(async ({ dir, wsId, bpId }) => {
        // Exactly the incident: BUILD makes its tree, then the branch is handed
        // to a chat (transfer, mode=take) and never handed back. The blueprint's
        // next phase looks up by owner, finds nothing, and falls back to the
        // primary tree — which is on `main` and cannot reach that branch.
        const built = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })
        assert.equal(built.isolated, true)

        const row = trackRepository.findByOwner('blueprint', bpId)
        assert.ok(row)
        const chatOwner = `chat-took-${bpId}`
        const moved = trackService.transferOwner(row.id, {
          ownerKind: 'chat',
          ownerId: chatOwner
        })
        assert.equal(moved.ok, true, 'the handoff itself is ordinary and allowed')

        const target = await ensureBlueprintTrack({
          blueprintId: bpId,
          workspaceId: wsId,
          workspacePath: dir
        })

        assert.equal(target.isolated, false)
        assert.equal(target.path, dir)
        assert.equal(target.heldBy?.ownerKind, 'chat')
        assert.equal(target.heldBy?.ownerId, chatOwner)
        assert.equal(
          target.heldBy?.path,
          built.path,
          'the worktree the agent actually writes in — the tree verification never looked at'
        )

        // The same fact is reachable from the VERIFY side, which resolves rather
        // than ensures.
        const viaResolve = findHandoffHolder(bpId)
        assert.equal(viaResolve?.ownerId, chatOwner)
        assert.equal(resolveBlueprintTrack(bpId, dir).path, dir)

        await trackService.releaseTrack('chat', chatOwner, { discard: true })
      })
    })

    test('the refusal names the holder, the tree and both ways out', () => {
      const msg = branchHeldElsewhereError({
        branchName: 'blueprint/data-agent-445eeb12',
        ownerKind: 'chat',
        ownerId: 'dea19fc2c83ea2d68423e32f964139f6',
        path: '/wt/ce8325fc/blueprint-data-agent-445-445eeb12'
      }).message

      assert.match(msg, /blueprint\/data-agent-445eeb12/)
      assert.match(msg, /dea19fc2c83ea2d68423e32f964139f6/, 'the id the user cannot otherwise see')
      assert.match(msg, /wt\/ce8325fc/)
      assert.match(msg, /takeover/, 'and how to get out of it without ending the chat')
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
