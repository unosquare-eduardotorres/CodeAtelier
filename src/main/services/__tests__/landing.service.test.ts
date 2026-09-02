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
  // `github.service` is in the group so the stubs below patch the SAME
  // singleton the reloaded `landing.service` binds to. Patched at the object
  // rather than the module level for the same reason.
  const [trackRepoMod, , , trackMod, , githubMod, landingMod] = reloadWithRealDeps([
    require.resolve('../../db/repositories/track.repository'),
    require.resolve('../../db/repositories/workspace.repository'),
    require.resolve('../../db/repositories/track-file-claim.repository'),
    require.resolve('../track.service'),
    require.resolve('../track-claims.service'),
    require.resolve('../github.service'),
    require.resolve('../landing.service')
  ]) as [
    typeof import('../../db/repositories/track.repository'),
    unknown,
    unknown,
    typeof import('../track.service'),
    unknown,
    typeof import('../github.service'),
    typeof import('../landing.service')
  ]
  const { trackRepository } = trackRepoMod
  const { trackService } = trackMod
  const { githubService } = githubMod
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

  // ── Independent-mode fixtures ──────────────────────────────────────

  type PrParams = Parameters<typeof githubService.createPullRequest>[0]
  type PrResult = Awaited<ReturnType<typeof githubService.createPullRequest>>

  /** What GitHub does for one workspace, for the duration of one test. */
  interface GitHubStub {
    configured: boolean
    createPullRequest?: (p: PrParams) => Promise<PrResult>
  }

  /** How the repo under test is wired to a remote. */
  type RemoteKind = 'bare' | 'broken' | 'none'

  /**
   * GitHub, stubbed exactly once and dispatched on workspace id.
   *
   * This harness runs tests CONCURRENTLY. A stub that swaps the singleton's
   * methods for the duration of one test is therefore clobbered by a sibling's
   * swap-and-restore, which surfaces as the PR test seeing
   * `isConfigured() === false` and asserting against a PR that was never
   * requested — intermittently, since it depends on interleaving. Replacing the
   * methods once and routing on `workspaceId` — unique per test, and the one
   * argument both methods are handed — removes the race instead of hiding it
   * behind serialisation.
   *
   * Patching the singleton for the whole file is contained: this is the private
   * copy `reloadWithRealDeps` handed us, and its cache entry was already put
   * back, so no other test file can reach the object being patched here.
   */
  const ghBehaviour = new Map<string, GitHubStub>()
  const ghCalls = new Map<string, PrParams[]>()

  githubService.isConfigured = (workspaceId: string): boolean =>
    ghBehaviour.get(workspaceId)?.configured ?? false

  githubService.createPullRequest = async (p: PrParams): Promise<PrResult> => {
    ghCalls.get(p.workspaceId)?.push(p)
    const impl = ghBehaviour.get(p.workspaceId)?.createPullRequest
    if (!impl) throw new Error(`createPullRequest is not stubbed for ${p.workspaceId}`)
    return impl(p)
  }

  /**
   * A repo whose workspace lands in `independent` mode — the DEFAULT.
   *
   * The remote is a local bare repository, which is a real git remote: `push`
   * genuinely pushes and `ls-remote` genuinely answers, so the push half of
   * independent landing is assertable without GitHub and without a network.
   *
   * `broken` points origin at a path that does not exist, which is the only way
   * to reach the catch around push; `none` omits the remote entirely, which
   * takes the `remotes.length > 0` guard instead. Those are different branches
   * and only one of them is reachable per repo, hence the parameter.
   */
  async function withIndependentRepo(
    opts: { remote: RemoteKind; github?: GitHubStub },
    fn: (ctx: { dir: string; wsId: string; bare: string; prCalls: PrParams[] }) => Promise<void>
  ): Promise<void> {
    const { remote } = opts
    const dir = await mkdtemp(join(tmpdir(), 'landing-ind-'))
    const bare = await mkdtemp(join(tmpdir(), 'landing-remote-'))
    const wsId = `land-ind-ws-${seq++}`
    const prCalls: PrParams[] = []
    ghBehaviour.set(wsId, opts.github ?? { configured: false })
    ghCalls.set(wsId, prCalls)
    try {
      await simpleGit(bare).init(['--bare', '--initial-branch=main'])

      const git = simpleGit(dir)
      await git.init(['--initial-branch=main'])
      await git.addConfig('user.email', 'test@example.com')
      await git.addConfig('user.name', 'Code Atelier Test')
      await git.addConfig('commit.gpgsign', 'false')
      await writeFile(join(dir, 'shared.txt'), 'base\n')
      await git.add('.')
      await git.commit('base')

      if (remote === 'bare') {
        await git.addRemote('origin', bare)
        await git.push('origin', 'main')
      } else if (remote === 'broken') {
        await git.addRemote('origin', join(bare, 'nope-does-not-exist.git'))
      }

      db()
        .prepare('INSERT INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(wsId, `Landing workspace ${wsId}`, dir)
      // Empty settings on purpose: `independent` is what a workspace that has
      // never touched the setting gets, and that is precisely the path here.
      db().prepare('UPDATE workspaces SET settings_json = ? WHERE id = ?').run('{}', wsId)

      await fn({ dir, wsId, bare, prCalls })
    } finally {
      ghBehaviour.delete(wsId)
      ghCalls.delete(wsId)
      await rm(dir, { recursive: true, force: true })
      await rm(bare, { recursive: true, force: true })
    }
  }

  /** Does the bare remote carry `branch`? */
  const remoteHas = async (dir: string, bare: string, branch: string): Promise<boolean> =>
    (await simpleGit(dir).listRemote(['--heads', bare, branch])).includes(`refs/heads/${branch}`)

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

    test('an integration branch is its own target — the prefix never compounds', () => {
      // Blueprints fork from the integration branch once it is ahead, so their
      // track's base IS `integration/<x>`. Deriving blindly would send the next
      // landing to `integration/integration/<x>` — a fresh empty branch per
      // run, which is the exact accumulation the integration branch prevents.
      assert.equal(integrationBranchFor('integration/main'), 'integration/main')
      assert.equal(integrationBranchFor(integrationBranchFor('develop')), 'integration/develop')
    })
  })

  // ── Independent landing — the default, and what every isolated chat gets ──

  describe('independent landing', () => {
    test('pushes the branch, sets upstream, and lands into the base', async () => {
      await withIndependentRepo({ remote: 'bare' }, async ({ dir, wsId, bare }) => {
        const t = await makeTrack(wsId, dir, `ind-a-${wsId}`, 'feat/ind-a', 'a.txt', 'from a\n')

        const result = await landingService.land(t.id, { commitMessage: 'add a' })

        assert.equal(result.outcome, 'landed')
        assert.equal(result.landedInto, 'main')
        assert.ok(result.commitHash)

        assert.equal(await remoteHas(dir, bare, 'feat/ind-a'), true, 'branch reached the remote')

        // Upstream is set, so a later push from that tree needs no arguments.
        const upstream = (
          await simpleGit(t.path).raw(['rev-parse', '--abbrev-ref', 'feat/ind-a@{upstream}'])
        ).trim()
        assert.equal(upstream, 'origin/feat/ind-a')

        const row = trackRepository.findById(t.id)!
        assert.ok(row.landedAt)
        assert.equal(row.landedInto, 'main', 'independent lands into the base, not integration/*')

        // Independent mode involves the user's checkout no more than integration does.
        assert.equal(await headOf(dir), 'main')
        assert.equal(await statusOf(dir), '')
        assert.equal(existsSync(join(dir, 'a.txt')), false)

        await trackService.discard(t.id)
      })
    })

    test('a track with nothing new is neither pushed nor opened as a PR', async () => {
      // GitHub deliberately configured: the short-circuit has to happen before
      // BOTH the push and the PR, not just before one of them.
      await withIndependentRepo(
        {
          remote: 'bare',
          github: {
            configured: true,
            createPullRequest: async () => ({ prUrl: 'https://github.test/pr/1', prNumber: 1 })
          }
        },
        async ({ dir, wsId, bare, prCalls }) => {
          const ownerId = `ind-empty-${wsId}`
          await trackService.ensureTrack({
            ownerKind: 'manual',
            ownerId,
            workspaceId: wsId,
            repoPath: dir,
            branchName: 'feat/ind-empty',
            baseBranch: 'main'
          })
          const row = trackRepository.findByOwner('manual', ownerId)!

          const result = await landingService.land(row.id, { commitMessage: 'nothing' })

          assert.equal(result.outcome, 'nothing-to-land')
          assert.equal(result.landedInto, null)
          assert.equal(trackRepository.findById(row.id)?.landedAt, null)
          assert.equal(await remoteHas(dir, bare, 'feat/ind-empty'), false, 'nothing pushed')
          assert.equal(prCalls.length, 0, 'and no PR opened')

          await trackService.discard(row.id)
        }
      )
    })

    test('opens the PR against the base, from the repository rather than the worktree', async () => {
      await withIndependentRepo(
        {
          remote: 'bare',
          github: {
            configured: true,
            createPullRequest: async () => ({ prUrl: 'https://github.test/pr/7', prNumber: 7 })
          }
        },
        async ({ dir, wsId, prCalls }) => {
          const t = await makeTrack(wsId, dir, `ind-b-${wsId}`, 'feat/ind-b', 'b.txt', 'from b\n')

          const result = await landingService.land(t.id, {
            commitMessage: 'add b',
            description: 'why b'
          })

          assert.equal(result.outcome, 'landed')
          assert.equal(result.prUrl, 'https://github.test/pr/7')
          assert.equal(result.prNumber, 7)

          const call = prCalls[0]
          assert.ok(call, 'a PR should have been requested')
          assert.equal(prCalls.length, 1)
          assert.equal(call.head, 'feat/ind-b')
          assert.equal(call.base, 'main')
          assert.equal(call.title, 'add b')
          assert.equal(call.body, 'why b')
          // A PR is a property of the repository, not of the worktree: handing
          // over the worktree path leaves parseRemoteUrl with no remote to read.
          assert.equal(call.repoPath, dir)

          await trackService.discard(t.id)
        }
      )
    })

    test('a failed PR leaves the work pushed and the track landed', async () => {
      await withIndependentRepo(
        {
          remote: 'bare',
          github: {
            configured: true,
            createPullRequest: async () => {
              throw new Error('422 Validation Failed')
            }
          }
        },
        async ({ dir, wsId, bare }) => {
          const t = await makeTrack(wsId, dir, `ind-c-${wsId}`, 'feat/ind-c', 'c.txt', 'from c\n')

          const result = await landingService.land(t.id, { commitMessage: 'add c' })

          // A PR that could not be opened is recoverable by hand; undoing a
          // push that already succeeded is not.
          assert.equal(result.outcome, 'landed')
          assert.equal(result.prUrl, undefined)
          assert.equal(result.prNumber, undefined)
          assert.equal(await remoteHas(dir, bare, 'feat/ind-c'), true)
          assert.ok(trackRepository.findById(t.id)?.landedAt)

          await trackService.discard(t.id)
        }
      )
    })

    test('a push that fails still commits the work and still lands', async () => {
      await withIndependentRepo({ remote: 'broken' }, async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `ind-d-${wsId}`, 'feat/ind-d', 'd.txt', 'from d\n')

        const result = await landingService.land(t.id, { commitMessage: 'add d' })

        // The commit is the part that must survive. A push can be retried; a
        // commit that was never made is unrecoverable work.
        assert.equal(result.outcome, 'landed')
        assert.ok(result.commitHash)
        assert.equal((await simpleGit(t.path).revparse(['HEAD'])).trim(), result.commitHash)
        assert.equal(await statusOf(t.path), '', 'nothing left uncommitted in the track')
        assert.ok(trackRepository.findById(t.id)?.landedAt)

        await trackService.discard(t.id)
      })
    })

    test('a repo with no remote lands without attempting a push', async () => {
      await withIndependentRepo({ remote: 'none' }, async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `ind-e-${wsId}`, 'feat/ind-e', 'e.txt', 'from e\n')

        const result = await landingService.land(t.id, { commitMessage: 'add e' })

        assert.equal(result.outcome, 'landed')
        assert.equal(result.landedInto, 'main')
        assert.ok(trackRepository.findById(t.id)?.landedAt)

        await trackService.discard(t.id)
      })
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

    test('a track marked landed whose work never arrived is not collected', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `gc-d-${wsId}`, 'feat/gc-d', 'gc.txt', 'gc\n')
        const git = simpleGit(t.path)
        await git.add('.')
        await git.commit('work that exists nowhere else')
        const head = (await git.revparse(['HEAD'])).trim()

        // Exactly the state a failed push leaves behind: `landIndependent`
        // pushes best-effort, only warns when that fails, and marks the track
        // landed regardless. `findLanded` selects on that flag alone, so GC
        // would force-delete a branch holding the only copy of this commit.
        trackRepository.markLanded(t.id, 'main')

        await landingService.gcLandedTracks(wsId)

        assert.ok(trackRepository.findById(t.id), 'the row survived')
        const branches = await simpleGit(dir).branchLocal()
        assert.equal(branches.all.includes('feat/gc-d'), true, 'the branch survived')
        assert.equal(
          (await simpleGit(dir).revparse(['feat/gc-d'])).trim(),
          head,
          'and still points at the unreachable commit'
        )

        await trackService.discard(t.id)
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

  // ── Integration → mainline ──────────────────────────────────

  /**
   * Blueprints land into the integration branch on their own; nothing moves
   * that work on to the mainline without the user. These cover the one step
   * that touches the user's checkout, and every case where it must refuse to.
   */
  describe('integration → mainline', () => {
    /** A landed track whose merge commit carries `subject`. */
    async function landOne(
      wsId: string,
      dir: string,
      name: string,
      file: string,
      subject: string
    ): Promise<{ id: string; path: string }> {
      const t = await makeTrack(wsId, dir, `${name}-${wsId}`, `feat/${name}`, file, `${file}\n`)
      // Committed inside the track, so the subject has nowhere to land but the
      // merge commit — the case where the review tag used to disappear.
      const git = simpleGit(t.path)
      await git.add('.')
      await git.commit(`agent committed ${file}`)
      const result = await landingService.land(t.id, { commitMessage: subject })
      assert.equal(result.outcome, 'landed')
      return t
    }

    test('the merge commit carries the caller’s subject, not git’s default', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const subject = '[human-review-needed] Add m (blueprint abc12345)'
        const t = await landOne(wsId, dir, 'msg-a', 'm.txt', subject)

        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)!
        const actual = (
          await simpleGit(integration.path).raw(['log', '-1', '--format=%s'])
        ).trim()
        // `--no-edit` would have written "Merge branch 'feat/msg-a'", losing the
        // blueprint title and the tag that keeps unproven work identifiable.
        assert.equal(actual, subject)

        await trackService.discard(t.id)
        await trackService.discard(integration.id)
      })
    })

    test('reports what is waiting, then fast-forwards it on request', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await landOne(wsId, dir, 'ml-a', 'ml.txt', '[human-review-needed] unproven')

        const before = (await landingService.mainlineStatus(wsId))!
        assert.equal(before.baseBranch, 'main')
        assert.equal(before.integrationBranch, 'integration/main')
        assert.equal(before.exists, true)
        assert.equal(before.ahead, 2, 'the track commit and the merge commit')
        assert.equal(before.behind, 0)
        assert.equal(before.humanReviewCount, 1, 'only the tagged merge commit counts')
        assert.equal(before.primaryTreeDirty, false)
        assert.equal(before.canFastForward, true)

        const result = await landingService.syncMainline(wsId)
        assert.equal(result.outcome, 'fast-forwarded')
        assert.equal(result.commitCount, 2)

        // The point of the whole exercise: the work is finally on the branch
        // the user actually works on.
        assert.equal(await headOf(dir), 'main')
        assert.equal(existsSync(join(dir, 'ml.txt')), true)

        const after = (await landingService.mainlineStatus(wsId))!
        assert.equal(after.ahead, 0)
        assert.equal(after.canFastForward, false)

        // Idempotent: nothing waiting means nothing done.
        assert.equal((await landingService.syncMainline(wsId)).outcome, 'up-to-date')

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('a mainline that has moved is never merged into the checkout', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await landOne(wsId, dir, 'ml-b', 'mlb.txt', 'landed work')

        // The user commits directly to the mainline, so promotion stops being a
        // fast-forward. GitHub is not configured here, so there is nowhere to
        // put a PR — and the answer must be "blocked", never a local merge.
        const mainGit = simpleGit(dir)
        await writeFile(join(dir, 'shared.txt'), 'user edit\n')
        await mainGit.add('.')
        await mainGit.commit('direct to main')
        const headBefore = (await mainGit.revparse(['HEAD'])).trim()

        const status = (await landingService.mainlineStatus(wsId))!
        assert.ok(status.behind > 0, 'divergence is visible before the button is pressed')
        assert.equal(status.canFastForward, false)

        const result = await landingService.syncMainline(wsId)
        assert.equal(result.outcome, 'blocked')
        assert.match(result.reason ?? '', /pull request/)

        assert.equal((await mainGit.revparse(['HEAD'])).trim(), headBefore, 'main did not move')
        assert.equal(existsSync(join(dir, 'mlb.txt')), false, 'and gained nothing')

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('a dirty checkout blocks the fast-forward instead of risking it', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await landOne(wsId, dir, 'ml-c', 'mlc.txt', 'landed work')

        // A tracked file modified in the user's own checkout.
        await writeFile(join(dir, 'shared.txt'), 'half-finished\n')

        const status = (await landingService.mainlineStatus(wsId))!
        assert.equal(status.primaryTreeDirty, true)
        assert.equal(status.canFastForward, false, 'ahead, but not safely')

        const result = await landingService.syncMainline(wsId)
        assert.equal(result.outcome, 'blocked')
        assert.match(result.reason ?? '', /uncommitted changes/)
        assert.equal(
          (await readFile(join(dir, 'shared.txt'), 'utf8')).trim(),
          'half-finished',
          'the user’s in-progress edit is exactly as they left it'
        )

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('an untracked stray file does not block anything', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await landOne(wsId, dir, 'ml-d', 'mld.txt', 'landed work')

        // Every repo has one of these. A fast-forward cannot collide with a file
        // git is not tracking, so counting it as dirty would disable the button
        // permanently for no reason.
        await writeFile(join(dir, 'scratch.local'), 'notes\n')

        const status = (await landingService.mainlineStatus(wsId))!
        assert.equal(status.primaryTreeDirty, false)
        assert.equal(status.canFastForward, true)
        assert.equal((await landingService.syncMainline(wsId)).outcome, 'fast-forwarded')

        await trackService.discard(t.id)
        const integration = trackRepository.findByOwner('manual', `integration:${wsId}`)
        if (integration) await trackService.discard(integration.id)
      })
    })

    test('a workspace where nothing has landed has nothing to promote', async () => {
      await withRepo(async ({ wsId }) => {
        const status = (await landingService.mainlineStatus(wsId))!
        assert.equal(status.exists, false, 'integration/main is not a ref yet')
        assert.equal(status.ahead, 0)
        assert.equal(status.canFastForward, false)
        assert.equal((await landingService.syncMainline(wsId)).outcome, 'up-to-date')
      })
    })
  })

  // ── Preview ──────────────────────────────────────────────

  /**
   * The forecast is the reason this exists, and it is the one thing that cannot
   * be checked without real git: `merge-tree` computes the merge in the object
   * store, and whether it reports a conflict depends on actual content overlap.
   *
   * The load-bearing property throughout: previewing must CHANGE NOTHING. Every
   * test below re-checks the branch head and the working tree afterwards,
   * because a preview that quietly commits or merges is far worse than no
   * preview at all.
   */
  describe('previewLanding', () => {
    test('a clean track reports what it would do, and does none of it', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `pv-a-${wsId}`, 'feat/pv-a', 'pv-a.txt', 'a\n')
        const git = simpleGit(t.path)
        await git.add('.')
        await git.commit('work')
        const headBefore = (await git.revparse(['HEAD'])).trim()

        const preview = await landingService.previewLanding(t.id)

        assert.equal(preview.branch, t.branchName)
        assert.equal(preview.mode, 'integration', 'the workspace setting is honoured')
        assert.equal(preview.target, integrationBranchFor('main'))
        assert.equal(preview.commitCount, 1)
        assert.deepEqual(preview.uncommittedFiles, [])
        assert.equal(preview.nothingToLand, false)
        assert.equal(preview.forecast, 'clean')
        assert.deepEqual(preview.conflictFiles, [])
        assert.equal(preview.opensPullRequest, false, 'integration mode never opens a PR')

        // Nothing moved, nothing merged, nothing landed.
        assert.equal((await git.revparse(['HEAD'])).trim(), headBefore)
        assert.equal((await git.raw(['status', '--porcelain'])).trim(), '')
        assert.equal(trackRepository.findById(t.id)!.landedAt, null)

        await trackService.discard(t.id)
      })
    })

    test('a real conflict is predicted by name, without merging anything', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // Both sides change the same line of `shared.txt`, which is the only way
        // to produce a genuine content conflict rather than a clean merge.
        const t = await makeTrack(wsId, dir, `pv-c-${wsId}`, 'feat/pv-c', 'shared.txt', 'track\n')
        const trackGit = simpleGit(t.path)
        await trackGit.add('.')
        await trackGit.commit('track side')

        const mainGit = simpleGit(dir)
        await writeFile(join(dir, 'shared.txt'), 'main\n')
        await mainGit.add('.')
        await mainGit.commit('main side')

        const preview = await landingService.previewLanding(t.id, { mode: 'independent' })

        assert.equal(preview.forecast, 'conflicts')
        assert.deepEqual(preview.conflictFiles, ['shared.txt'])
        assert.equal(preview.target, 'main')

        // The forecast must not have been obtained by attempting the merge.
        assert.equal((await trackGit.raw(['status', '--porcelain'])).trim(), '')
        assert.equal(
          (await mainGit.raw(['status', '--porcelain'])).trim(),
          '',
          'the user’s own checkout is untouched'
        )
        assert.ok(!existsSync(join(dir, '.git', 'MERGE_HEAD')), 'no merge was started')

        await trackService.discard(t.id)
      })
    })

    test('an uncommitted tree is something to land, not nothing', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // Zero commits ahead but a dirty tree. Landing commits it first, so
        // reporting "nothing to land" here would talk the user out of saving
        // work that exists nowhere else.
        const t = await makeTrack(wsId, dir, `pv-d-${wsId}`, 'feat/pv-d', 'pv-d.txt', 'dirty\n')

        const preview = await landingService.previewLanding(t.id)

        assert.equal(preview.commitCount, 0)
        assert.deepEqual(preview.uncommittedFiles, ['pv-d.txt'])
        assert.equal(preview.nothingToLand, false)

        await trackService.discard(t.id)
      })
    })

    test('a track with nothing at all says so', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const target = await trackService.ensureTrack({
          ownerKind: 'manual',
          ownerId: `pv-e-${wsId}`,
          workspaceId: wsId,
          repoPath: dir,
          branchName: 'feat/pv-e',
          baseBranch: 'main'
        })
        const row = trackRepository.findByOwner('manual', `pv-e-${wsId}`)!

        const preview = await landingService.previewLanding(row.id)

        assert.equal(preview.commitCount, 0)
        assert.deepEqual(preview.uncommittedFiles, [])
        assert.equal(preview.nothingToLand, true)
        assert.ok(existsSync(target.path))

        await trackService.discard(row.id)
      })
    })

    test('the caller can override the mode, and the target follows it', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // The workspace is set to `integration`; asking for `independent`
        // retargets the preview at the base branch. Getting this wrong would
        // forecast against the wrong branch entirely.
        const t = await makeTrack(wsId, dir, `pv-f-${wsId}`, 'feat/pv-f', 'pv-f.txt', 'f\n')
        await simpleGit(t.path).add('.')
        await simpleGit(t.path).commit('work')

        const asIntegration = await landingService.previewLanding(t.id)
        const asIndependent = await landingService.previewLanding(t.id, { mode: 'independent' })

        assert.equal(asIntegration.target, integrationBranchFor('main'))
        assert.equal(asIndependent.target, 'main')
        assert.equal(asIndependent.mode, 'independent')

        await trackService.discard(t.id)
      })
    })

    test('an integration branch that does not exist yet forecasts against its base', async () => {
      await withRepo(async ({ dir, wsId }) => {
        // Nothing has ever landed here, so `integration/main` is not a ref. The
        // preview must not report `unknown` — the branch will be cut from the
        // base, so the base is exactly the right thing to compare against.
        const t = await makeTrack(wsId, dir, `pv-g-${wsId}`, 'feat/pv-g', 'pv-g.txt', 'g\n')
        await simpleGit(t.path).add('.')
        await simpleGit(t.path).commit('work')

        const preview = await landingService.previewLanding(t.id)

        assert.equal(preview.target, integrationBranchFor('main'), 'still reports the real target')
        assert.equal(preview.forecast, 'clean')
        assert.equal(preview.commitCount, 1)

        await trackService.discard(t.id)
      })
    })

    test('a base that cannot be resolved is unknown, not clean', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `pv-h-${wsId}`, 'feat/pv-h', 'pv-h.txt', 'h\n')
        await simpleGit(t.path).add('.')
        await simpleGit(t.path).commit('work')

        const preview = await landingService.previewLanding(t.id, {
          mode: 'independent',
          baseBranch: 'origin/never-fetched'
        })

        // Reporting `clean` here would promise a merge nobody checked.
        assert.equal(preview.forecast, 'unknown')
        assert.deepEqual(preview.conflictFiles, [])

        await trackService.discard(t.id)
      })
    })

    test('previewing reports the PR that independent landing would open', async () => {
      await withIndependentRepo(
        { remote: 'bare', github: { configured: true } },
        async ({ dir, wsId }) => {
          const t = await makeTrack(wsId, dir, `pv-pr-${wsId}`, 'feat/pv-pr', 'pr.txt', 'pr\n')
          await simpleGit(t.path).add('.')
          await simpleGit(t.path).commit('work')

          const preview = await landingService.previewLanding(t.id)

          assert.equal(preview.mode, 'independent')
          assert.equal(preview.hasRemote, true)
          assert.equal(preview.opensPullRequest, true)

          await trackService.discard(t.id)
        }
      )
    })

    test('a repo with no remote says the work stays local', async () => {
      await withIndependentRepo({ remote: 'none' }, async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `pv-nr-${wsId}`, 'feat/pv-nr', 'nr.txt', 'nr\n')
        await simpleGit(t.path).add('.')
        await simpleGit(t.path).commit('work')

        const preview = await landingService.previewLanding(t.id)

        assert.equal(preview.hasRemote, false)
        assert.equal(preview.opensPullRequest, false)

        await trackService.discard(t.id)
      })
    })

    test('a track whose tree is gone is refused rather than guessed at', async () => {
      await withRepo(async ({ dir, wsId }) => {
        const t = await makeTrack(wsId, dir, `pv-x-${wsId}`, 'feat/pv-x', 'x.txt', 'x\n')
        await rm(t.path, { recursive: true, force: true })

        await assert.rejects(
          () => landingService.previewLanding(t.id),
          /has no working tree/,
          'a preview computed from a missing tree would be fiction'
        )

        await trackService.discard(t.id)
      })
    })

    test('an unknown track id is refused', async () => {
      await assert.rejects(() => landingService.previewLanding('not-a-track'), /not found/)
    })
  })

  // ── merge-tree parsing ────────────────────────────────────────

  /**
   * `merge-tree` exits non-zero for a conflict AND for a ref it cannot resolve,
   * so the exit code cannot distinguish them. The tree OID on the first line is
   * what does, and these pin that contract — the shapes come from real git
   * output (2.55).
   */
  describe('parseMergeTreeOutput', () => {
    const { parseMergeTreeOutput } = landingMod

    test('a clean merge prints only the tree it produced', () => {
      const out = parseMergeTreeOutput('83eed1af0956e178240208dda7665a6eeff4861c\n')
      assert.equal(out.forecast, 'clean')
      assert.deepEqual(out.files, [])
    })

    test('a conflict lists its files between the tree and the blank line', () => {
      const out = parseMergeTreeOutput(
        'e483da17a658270f0811008fb8990dc83c970805\n' +
          'src/a.ts\n' +
          'src/b.ts\n' +
          '\n' +
          'Auto-merging src/a.ts\n' +
          'CONFLICT (content): Merge conflict in src/a.ts\n'
      )
      assert.equal(out.forecast, 'conflicts')
      assert.deepEqual(out.files, ['src/a.ts', 'src/b.ts'])
    })

    test('the informational messages are never mistaken for filenames', () => {
      // Without the blank-line stop, "Auto-merging src/a.ts" becomes a conflicted
      // path and the dialog names files that merged perfectly well.
      const out = parseMergeTreeOutput(
        'e483da17a658270f0811008fb8990dc83c970805\nsrc/a.ts\n\nAuto-merging src/a.ts\n'
      )
      assert.deepEqual(out.files, ['src/a.ts'])
    })

    test('output with no tree oid is unknown, never clean', () => {
      // What an unresolvable ref leaves behind. Treating an empty parse as a
      // clean merge is the dangerous direction.
      assert.equal(parseMergeTreeOutput('').forecast, 'unknown')
      assert.equal(
        parseMergeTreeOutput('merge-tree: nope - not something we can merge\n').forecast,
        'unknown'
      )
    })

    test('a sha-256 repository is understood', () => {
      const oid = 'a'.repeat(64)
      assert.equal(parseMergeTreeOutput(`${oid}\n`).forecast, 'clean')
      assert.equal(parseMergeTreeOutput(`${oid}\nf.txt\n\n`).forecast, 'conflicts')
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
