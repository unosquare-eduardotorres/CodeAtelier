/**
 * Landing — getting a track's work back to the mainline.
 *
 * Before this there was exactly one way work left a track: `handleChatComplete`
 * in chat-completion.ipc.ts. It commits, pushes and opens a PR, and it does all
 * of that for one chat at a time with no notion of tracks as a class — so a
 * blueprint run's branch, a campaign's branch and a retained tree the user
 * adopted had no route home at all.
 *
 * Three properties this has to hold, each paid for by a way the naive version
 * goes wrong:
 *
 *  1. **The user's checkout is never involved.** Merging in the primary tree
 *     means moving a HEAD that agents and the user are both looking at, and a
 *     conflict there leaves the user's working copy in a half-merged state they
 *     did not ask for. Integration merges happen in a worktree owned by this
 *     service; the primary tree is not touched, not even read.
 *
 *  2. **Landings serialise per workspace.** Two tracks merging into one
 *     integration branch at the same time is a race with a corrupted branch at
 *     the end of it. A promise chain per workspace is enough — landings are
 *     rare, human-initiated and short.
 *
 *  3. **A conflict is an outcome, not a failure.** Nothing is auto-resolved,
 *     the merge is aborted, both branches survive exactly as they were, and the
 *     track is marked `conflicted` so it is visible rather than silently stuck.
 *
 * Two landing modes:
 *
 *  - `independent` (default) — the track's branch is pushed and opened as its
 *    own PR. This is what `/complete` always did.
 *  - `integration` — the track merges into a shared cumulative branch held by
 *    the integration worktree, for people who want one PR per batch of work.
 */

import { existsSync } from 'node:fs'
import simpleGit, { type SimpleGit } from 'simple-git'
import log from 'electron-log'
import { trackRepository } from '../db/repositories/track.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { trackService } from './track.service'
import { trackClaimsService } from './track-claims.service'
import { githubService } from './github.service'
import { COMMIT_ATTRIBUTION } from '../../shared/constants'
import type {
  ConflictForecast,
  LandingPreview,
  LandingResult,
  MainlineSyncResult,
  MainlineSyncStatus,
  TrackLandingMode,
  WorkTrack
} from '../../shared/track-types'

const landLog = log.scope('landing')

/** Workspace default when neither the track nor the workspace says otherwise. */
export const DEFAULT_LANDING_MODE: TrackLandingMode = 'independent'

/**
 * How often landed branches are collected while the app stays open.
 *
 * Daily. Branch-per-chat plus branch-per-blueprint produces a few branches a
 * day at most, and every candidate is already merged — there is nothing here
 * worth being eager about.
 */
export const BRANCH_GC_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface LandOptions {
  /** Commit subject for anything still uncommitted in the track. */
  commitMessage: string
  /** Commit body / PR body. */
  description?: string
  /** Overrides the track's base branch as the PR target. Ignored in integration mode. */
  baseBranch?: string
  /** Force a mode for this landing, ignoring track and workspace settings. */
  mode?: TrackLandingMode
}

/**
 * Integration branch for a workspace.
 *
 * Derived from the base rather than fixed, so a repo whose mainline is `develop`
 * does not silently accumulate work on a branch named after `main`.
 */
export function integrationBranchFor(baseBranch: string): string {
  const slug = baseBranch.replace(/[^a-zA-Z0-9._/-]+/g, '-')
  if (!slug) return 'integration/main'
  // Already an integration branch — it is its own target.
  //
  // Blueprints fork from `integration/<base>` once it exists and is ahead, so
  // their track records that as its base. Deriving blindly would give the next
  // run `integration/integration/<base>`, and the run after that another level
  // — a fresh empty branch per blueprint, which is the exact accumulation
  // problem the integration branch exists to solve. Fork from it, land back
  // into it.
  if (slug.startsWith('integration/')) return slug
  return `integration/${slug}`
}

/** Owner key for the worktree this service merges in. One per workspace. */
function integrationOwnerId(workspaceId: string): string {
  return `integration:${workspaceId}`
}

/**
 * Read a conflict forecast out of `git merge-tree --write-tree --name-only`.
 *
 * The output is three sections and only the first two matter here:
 *
 *     <tree oid>
 *     path/one          ← conflicted files, one per line
 *     path/two
 *                       ← blank line ends the section
 *     Auto-merging …    ← human-readable messages
 *
 * The tree OID is printed whether or not the merge conflicted, which is what
 * makes this parseable without trusting the exit code — merge-tree exits 1 for
 * a conflict AND for a ref it cannot resolve, and those two must not be
 * confused. A missing OID means git never got as far as merging, so the honest
 * answer is `unknown` rather than a guess in either direction.
 */
export function parseMergeTreeOutput(stdout: string): {
  forecast: ConflictForecast
  files: string[]
} {
  const lines = stdout.split('\n')
  // SHA-1 is 40 chars, SHA-256 repositories produce 64.
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(lines[0]?.trim() ?? '')) {
    return { forecast: 'unknown', files: [] }
  }

  const files: string[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    files.push(line.trim())
  }
  return files.length > 0 ? { forecast: 'conflicts', files } : { forecast: 'clean', files: [] }
}

class LandingService {
  /**
   * Per-workspace tail of the landing queue.
   *
   * In-memory: the invariant only needs to hold between landings that are
   * actually running, and a restart has nothing in flight to serialise.
   */
  private readonly queues = new Map<string, Promise<unknown>>()

  private gcTimer: ReturnType<typeof setInterval> | null = null

  /** Which mode a track lands in: per-track override → workspace → default. */
  resolveMode(track: WorkTrack): TrackLandingMode {
    if (track.landingMode) return track.landingMode
    try {
      const settings = workspaceRepository.getSettings(track.workspaceId) as {
        landingMode?: TrackLandingMode
      }
      if (settings.landingMode === 'integration' || settings.landingMode === 'independent') {
        return settings.landingMode
      }
    } catch (err) {
      landLog.warn(`[resolveMode] settings read failed: ${(err as Error).message}`)
    }
    return DEFAULT_LANDING_MODE
  }

  /**
   * What landing this track would do, without doing any of it.
   *
   * Nothing here writes: no commit, no push, no merge, no worktree created. The
   * conflict forecast comes from `git merge-tree`, which computes the merge in
   * the object store and hands back a tree nobody checks out — so asking "would
   * this conflict?" no longer requires finding out the hard way.
   *
   * Deliberately NOT queued behind `land()`. A preview is read-only and a user
   * opening the dialog while another track is landing should not stare at a
   * spinner until that finishes.
   */
  async previewLanding(
    trackId: string,
    opts?: { mode?: TrackLandingMode; baseBranch?: string }
  ): Promise<LandingPreview> {
    const track = trackRepository.findById(trackId)
    if (!track) throw new Error(`Track ${trackId} not found`)
    if (!existsSync(track.path)) {
      throw new Error(`Track ${track.id} has no working tree at ${track.path}`)
    }

    const git = simpleGit(track.path)
    const mode = opts?.mode ?? this.resolveMode(track)
    const base = opts?.baseBranch || track.baseBranch
    const target = mode === 'integration' ? integrationBranchFor(base) : base

    // The integration branch is created from the base on first landing, so
    // before then there is no such ref to compare against — and the honest
    // forecast is the one against what it will be created from. The user is
    // still told the work is going to the integration branch, because it is.
    const comparand = (await this.refExists(git, target)) ? target : base

    const uncommittedFiles = await this.pendingPaths(git)
    const commitCount = await this.countCommitsBeyond(git, comparand, track.branchName)
    const { forecast, files } = await this.forecastConflicts(git, comparand, track.branchName)

    return {
      mode,
      branch: track.branchName,
      target,
      commitCount,
      uncommittedFiles,
      // A dirty tree is something to land even with no commits ahead: landing
      // commits it first. Reporting "nothing to land" here would talk the user
      // out of saving work that only exists in the worktree.
      nothingToLand: commitCount === 0 && uncommittedFiles.length === 0,
      forecast,
      conflictFiles: files,
      hasRemote: await this.hasRemote(git),
      // Integration mode merges locally and never opens a PR, however well
      // GitHub is configured.
      opensPullRequest: mode === 'independent' && githubService.isConfigured(track.workspaceId)
    }
  }

  /**
   * Land one track, serialised against every other landing in its workspace.
   *
   * The queue is a plain promise chain and is deliberately failure-tolerant: a
   * rejected landing must not poison the tail and block every later one, so the
   * link stored back into the map always resolves.
   */
  async land(trackId: string, opts: LandOptions): Promise<LandingResult> {
    const track = trackRepository.findById(trackId)
    if (!track) throw new Error(`Track ${trackId} not found`)

    const previous = this.queues.get(track.workspaceId) ?? Promise.resolve()
    const run = previous.then(
      () => this.landNow(track, opts),
      () => this.landNow(track, opts)
    )
    this.queues.set(
      track.workspaceId,
      run.catch(() => undefined)
    )
    return run
  }

  /** Land the track a given owner holds. Returns null when it has no track. */
  async landOwner(
    ownerKind: WorkTrack['ownerKind'],
    ownerId: string,
    opts: LandOptions
  ): Promise<LandingResult | null> {
    const row = trackRepository.findByOwner(ownerKind, ownerId)
    if (!row) return null
    return this.land(row.id, opts)
  }

  // ── The actual landing ────────────────────────────────────────────

  private async landNow(track: WorkTrack, opts: LandOptions): Promise<LandingResult> {
    if (!existsSync(track.path)) {
      throw new Error(`Track ${track.id} has no working tree at ${track.path}`)
    }

    const git = simpleGit(track.path)
    const commitHash = await this.commitPending(git, track, opts)

    const mode = opts.mode ?? this.resolveMode(track)
    landLog.info(`[land] ${track.branchName} → mode=${mode}`)

    return mode === 'integration'
      ? this.landIntegration(track, opts, commitHash)
      : this.landIndependent(track, opts, commitHash)
  }

  /**
   * Commit whatever the agent left uncommitted in the track's tree.
   *
   * Returns the resulting HEAD, or undefined when there was nothing to commit —
   * a track whose agent already committed is a normal case, not an error.
   */
  private async commitPending(
    git: SimpleGit,
    track: WorkTrack,
    opts: LandOptions
  ): Promise<string | undefined> {
    const changed = await this.pendingPaths(git)
    if (changed.length === 0) return undefined

    await git.add(changed)
    const body = opts.description
      ? `${opts.description}\n\n${COMMIT_ATTRIBUTION}`
      : COMMIT_ATTRIBUTION
    await git.commit(`${opts.commitMessage}\n\n${body}`)
    const head = (await git.revparse(['HEAD'])).trim()
    landLog.info(`[land] committed ${changed.length} path(s) in ${track.branchName} → ${head}`)
    return head
  }

  /** Push the branch and open a PR against its base. */
  private async landIndependent(
    track: WorkTrack,
    opts: LandOptions,
    commitHash: string | undefined
  ): Promise<LandingResult> {
    const git = simpleGit(track.path)
    const base = opts.baseBranch || track.baseBranch
    const result: LandingResult = {
      outcome: 'landed',
      branch: track.branchName,
      landedInto: base,
      commitHash
    }

    if (!(await this.hasCommitsBeyond(git, base, track.branchName))) {
      landLog.info(`[land] ${track.branchName} has nothing ${base} does not already have`)
      return { ...result, outcome: 'nothing-to-land', landedInto: null }
    }

    // Push is best-effort: a repo with no remote is a normal local-only setup,
    // and the commit above is the part that must not be lost.
    try {
      const remotes = await git.getRemotes(true)
      if (remotes.length > 0) {
        await git.push('origin', track.branchName, ['--set-upstream'])
      }
    } catch (err) {
      landLog.warn(`[land] push failed (no remote or auth): ${(err as Error).message}`)
    }

    if (githubService.isConfigured(track.workspaceId)) {
      try {
        const workspace = workspaceRepository.findById(track.workspaceId)
        const pr = await githubService.createPullRequest({
          workspaceId: track.workspaceId,
          // PRs are a property of the repository, not of the worktree.
          repoPath: workspace?.repoPath ?? track.path,
          head: track.branchName,
          base,
          title: opts.commitMessage,
          body: opts.description ?? ''
        })
        result.prUrl = pr.prUrl
        result.prNumber = pr.prNumber
        landLog.info(`[land] PR ${pr.prUrl} opened for ${track.branchName}`)
      } catch (err) {
        // The push succeeded; a failed PR is recoverable by hand and must not
        // undo the landing.
        landLog.warn(`[land] PR creation failed: ${(err as Error).message}`)
      }
    }

    trackRepository.markLanded(track.id, base)
    trackClaimsService.clear(track.id)
    return result
  }

  /**
   * Merge the track into the workspace's integration branch.
   *
   * Every git command here runs in the integration worktree. That is the whole
   * point: the merge, and any conflict it produces, happen somewhere the user
   * is not standing.
   */
  private async landIntegration(
    track: WorkTrack,
    opts: LandOptions,
    commitHash: string | undefined
  ): Promise<LandingResult> {
    const base = track.baseBranch
    const integrationBranch = integrationBranchFor(base)
    const trackGit = simpleGit(track.path)

    if (!(await this.hasCommitsBeyond(trackGit, base, track.branchName))) {
      return {
        outcome: 'nothing-to-land',
        branch: track.branchName,
        landedInto: null,
        commitHash
      }
    }

    const integrationPath = await this.ensureIntegrationTree(track, integrationBranch, base)
    const git = simpleGit(integrationPath)

    // A conflicting `git merge` exits non-zero but writes its complaint to
    // STDOUT, and simple-git only rejects when a failing git wrote to stderr —
    // so the promise resolves and the conflict looks like success. The state of
    // the index is the only trustworthy signal, which is what
    // `--diff-filter=U` reads. (Same quirk TrackService.branchExists documents.)
    // `-m` rather than `--no-edit`, because the caller's subject is the only
    // place some of this work is described. `commitPending` writes it to a
    // commit ONLY when the track had uncommitted files; an agent that committed
    // as it went leaves nothing to commit, and the landing would then be
    // recorded as git's default "Merge branch 'x'". That loses the blueprint
    // title, and — the reason this matters — the `[human-review-needed]` tag,
    // whose entire job is to be readable in `git log` on the integration branch
    // before anything gets promoted to mainline.
    let mergeError: Error | null = null
    try {
      await git.raw([
        'merge',
        '--no-ff',
        '-m',
        `${opts.commitMessage}\n\nMerge ${track.branchName} into ${integrationBranch}.`,
        track.branchName
      ])
    } catch (err) {
      mergeError = err as Error
    }

    const conflictedFiles = await this.conflictedFiles(git)
    if (conflictedFiles.length > 0) {
      // Abort so the integration tree is left exactly as it was — a half-merged
      // worktree is a trap for the next landing, and the one thing we promise
      // is that both branches survive intact.
      await this.abortMerge(git)
      trackRepository.markConflicted(track.id)
      landLog.warn(
        `[land] ${track.branchName} conflicts with ${integrationBranch} in ` +
          `${conflictedFiles.join(', ')} — nothing merged, both branches left untouched`
      )
      return {
        outcome: 'conflicted',
        branch: track.branchName,
        landedInto: null,
        commitHash,
        conflictedFiles
      }
    }

    if (mergeError) {
      // Failed without producing conflicts — a dirty integration tree, a missing
      // ref, something structural. Not a conflict, and not something to paper
      // over as one: the caller needs the real message.
      await this.abortMerge(git)
      throw mergeError
    }

    trackRepository.markLanded(track.id, integrationBranch)
    // Landed work can no longer collide with anything, so it should stop being
    // reported as a predicted conflict against tracks that are still running.
    trackClaimsService.clear(track.id)
    landLog.info(`[land] merged ${track.branchName} into ${integrationBranch}`)
    return {
      outcome: 'landed',
      branch: track.branchName,
      landedInto: integrationBranch,
      commitHash
    }
  }

  /**
   * The worktree integration merges happen in, created on first landing.
   *
   * Registered as a `manual` track so it shows up in the Tracks list and the
   * reaper leaves it alone while it is in use — it is a real worktree with a
   * real branch, and hiding it would make an unexplained directory on disk.
   */
  private async ensureIntegrationTree(
    track: WorkTrack,
    integrationBranch: string,
    base: string
  ): Promise<string> {
    const workspace = workspaceRepository.findById(track.workspaceId)
    if (!workspace) throw new Error(`Workspace ${track.workspaceId} not found`)

    const target = await trackService.ensureTrack({
      ownerKind: 'manual',
      ownerId: integrationOwnerId(track.workspaceId),
      workspaceId: track.workspaceId,
      repoPath: workspace.repoPath,
      branchName: integrationBranch,
      baseBranch: base
    })

    if (!target.isolated) {
      // The primary tree already holds the integration branch, so merging would
      // move the HEAD the user is standing on — the one outcome this service
      // exists to prevent.
      throw new Error(
        `The integration branch "${integrationBranch}" is checked out in this workspace's ` +
          `main working copy. Switch it to another branch so landing can merge without ` +
          `disturbing your checkout.`
      )
    }
    return target.path
  }

  /**
   * Paths the agent left uncommitted in a track's tree.
   *
   * Shared by `commitPending` and `previewLanding` on purpose: the preview
   * promises "these files will be committed", and the only way that stays true
   * is for both to ask the same question.
   */
  private async pendingPaths(git: SimpleGit): Promise<string[]> {
    const status = await git.status()
    return [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...status.deleted,
      ...status.renamed.map((r) => r.to)
    ]
  }

  /** Does `branch` hold anything `base` does not? */
  private async hasCommitsBeyond(git: SimpleGit, base: string, branch: string): Promise<boolean> {
    try {
      const out = await git.raw(['rev-list', '--count', `${base}..${branch}`])
      return Number.parseInt(out.trim(), 10) > 0
    } catch (err) {
      // An unknown base (never fetched, or renamed) must not silently report
      // "nothing to land" and swallow the work.
      landLog.warn(
        `[land] could not compare ${branch} against ${base}: ${(err as Error).message} — ` +
          `proceeding as if there is work to land`
      )
      return true
    }
  }

  /**
   * How many commits `branch` holds that `base` does not.
   *
   * Returns 0 when the comparison cannot be made, unlike `hasCommitsBeyond`,
   * which assumes there is work. The asymmetry is deliberate: that one guards
   * against silently discarding commits, while this one only labels a dialog,
   * and "0 commits" beside a populated file list is less alarming than a
   * fabricated number.
   */
  private async countCommitsBeyond(git: SimpleGit, base: string, branch: string): Promise<number> {
    try {
      const out = await git.raw(['rev-list', '--count', `${base}..${branch}`])
      const n = Number.parseInt(out.trim(), 10)
      return Number.isFinite(n) ? n : 0
    } catch (err) {
      landLog.warn(`[preview] could not count ${base}..${branch}: ${(err as Error).message}`)
      return 0
    }
  }

  /**
   * Is this landed track's work provably somewhere else before we delete it?
   *
   * `findLanded` selects on `landed_at IS NOT NULL` alone, and `landed_at` is
   * written by `landIndependent` after a push whose failure is only a warning —
   * a repo with no remote, or an expired credential, both mark the track landed
   * with the commits still living nowhere but this branch. GC then force-deletes
   * it. The bookkeeping flag is therefore not evidence, and this asks git for
   * the fact instead: nothing on the branch that the target does not already
   * have.
   *
   * Errors keep the branch. `hasCommitsBeyond` reports "there is work" when the
   * comparison cannot be made, which is the safe answer for both of its callers
   * — landing proceeds, and GC declines.
   */
  private async isReclaimable(repoGit: SimpleGit, track: WorkTrack): Promise<boolean> {
    if (!track.landedInto) {
      landLog.warn(`[gc] ${track.branchName} is marked landed with no target — keeping`)
      return false
    }
    if (await this.hasCommitsBeyond(repoGit, track.landedInto, track.branchName)) {
      landLog.warn(
        `[gc] ${track.branchName} is marked landed into ${track.landedInto} but still holds ` +
          `commits that branch does not — keeping. The landing pushed or merged only partially.`
      )
      return false
    }
    return true
  }

  /** Is `ref` resolvable in this repository? */
  private async refExists(git: SimpleGit, ref: string): Promise<boolean> {
    try {
      await git.raw(['rev-parse', '--verify', `${ref}^{commit}`])
      return true
    } catch {
      return false
    }
  }

  /** Is there anywhere to push? */
  private async hasRemote(git: SimpleGit): Promise<boolean> {
    try {
      return (await git.getRemotes(true)).length > 0
    } catch {
      return false
    }
  }

  /**
   * Would merging `branch` into `target` conflict? Asked without merging.
   *
   * `merge-tree` exits non-zero for a conflict AND for an unresolvable ref, so
   * the exit code is useless on its own — but the two cases use different
   * streams. A conflict writes the tree OID and the file list to STDOUT and
   * nothing to stderr, which simple-git treats as success; a bad ref writes only
   * to stderr, which it rejects on. (Same quirk `landIntegration` documents for
   * `git merge`.) Both paths still parse whatever text they got, so a future
   * simple-git that rejects on conflicts degrades to a correct answer rather
   * than a wrong one.
   */
  private async forecastConflicts(
    git: SimpleGit,
    target: string,
    branch: string
  ): Promise<{ forecast: ConflictForecast; files: string[] }> {
    try {
      const out = await git.raw(['merge-tree', '--write-tree', '--name-only', target, branch])
      return parseMergeTreeOutput(out)
    } catch (err) {
      const text = (err as { stdout?: string }).stdout ?? (err as Error).message ?? ''
      const parsed = parseMergeTreeOutput(text)
      if (parsed.forecast === 'unknown') {
        landLog.warn(
          `[preview] could not forecast ${branch} → ${target}: ${(err as Error).message}`
        )
      }
      return parsed
    }
  }

  /** Best-effort `merge --abort`; there may be no merge in progress to abort. */
  private async abortMerge(git: SimpleGit): Promise<void> {
    try {
      await git.raw(['merge', '--abort'])
    } catch {
      /* nothing in progress */
    }
  }

  private async conflictedFiles(git: SimpleGit): Promise<string[]> {
    try {
      const out = await git.raw(['diff', '--name-only', '--diff-filter=U'])
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  // ── Integration → mainline ──────────────────────────────────────

  /**
   * Where the integration branch stands against the mainline it feeds.
   *
   * Read-only and cheap enough to sit on the Tracks list. The counts are the
   * early warning for the failure this design is most exposed to: blueprints
   * land into the integration branch unattended, so the gap between it and the
   * branch the user works on grows on its own, and a single direct commit to
   * the mainline turns every future promotion from a fast-forward into a PR
   * without announcing it.
   */
  async mainlineStatus(workspaceId: string): Promise<MainlineSyncStatus | null> {
    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace?.repoPath || !existsSync(workspace.repoPath)) return null

    const git = simpleGit(workspace.repoPath)
    let base: string
    try {
      base = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()
    } catch (err) {
      landLog.warn(`[mainline] no HEAD in ${workspace.repoPath}: ${(err as Error).message}`)
      return null
    }
    if (!base || base === 'HEAD') return null

    const integrationBranch = integrationBranchFor(base)
    const empty: MainlineSyncStatus = {
      baseBranch: base,
      integrationBranch,
      exists: false,
      ahead: 0,
      behind: 0,
      humanReviewCount: 0,
      canFastForward: false,
      primaryTreeDirty: false
    }

    // The checkout IS the integration branch. Nothing to promote to, and the
    // question is meaningless rather than answerable-as-zero.
    if (base === integrationBranch) return null
    if (!(await this.refExists(git, integrationBranch))) return empty

    const ahead = await this.countCommitsBeyond(git, base, integrationBranch)
    const behind = await this.countCommitsBeyond(git, integrationBranch, base)
    const dirty = await this.hasTrackedChanges(git)

    return {
      ...empty,
      exists: true,
      ahead,
      behind,
      humanReviewCount: await this.countHumanReviewCommits(git, base, integrationBranch),
      canFastForward: ahead > 0 && behind === 0 && !dirty,
      primaryTreeDirty: dirty
    }
  }

  /**
   * Tracked modifications in a working tree — the ones a merge can collide with.
   *
   * Deliberately NOT `pendingPaths`, which counts untracked files too. That is
   * the right question for landing, where an untracked file is work the agent
   * produced and the commit must sweep up. It is the wrong question here: a
   * fast-forward only fails on files git is already tracking, and a repo with a
   * stray scratch file in it is every repo. Reusing `pendingPaths` would leave
   * the Sync button permanently disabled for a tree that is perfectly safe to
   * fast-forward.
   */
  private async hasTrackedChanges(git: SimpleGit): Promise<boolean> {
    try {
      const status = await git.status()
      return (
        status.modified.length > 0 ||
        status.created.length > 0 ||
        status.deleted.length > 0 ||
        status.renamed.length > 0 ||
        status.staged.length > 0 ||
        status.conflicted.length > 0
      )
    } catch (err) {
      // Unknown state is treated as dirty: the only thing gated on this moves
      // the user's own checkout.
      landLog.warn(`[mainline] could not read working tree status: ${(err as Error).message}`)
      return true
    }
  }

  /**
   * Waiting commits that were landed by a blueprint nobody signed off.
   *
   * Matches the tag `autoLandBlueprint` writes into the merge subject. A count
   * rather than a list because its only job is to be a number beside a button:
   * "12 commits waiting, 4 unreviewed" is a different decision from "12 waiting".
   */
  private async countHumanReviewCommits(
    git: SimpleGit,
    base: string,
    integrationBranch: string
  ): Promise<number> {
    try {
      const out = await git.raw([
        'rev-list',
        '--count',
        '--grep=human-review-needed',
        `${base}..${integrationBranch}`
      ])
      const n = Number.parseInt(out.trim(), 10)
      return Number.isFinite(n) ? n : 0
    } catch (err) {
      landLog.warn(`[mainline] review-tag count failed: ${(err as Error).message}`)
      return 0
    }
  }

  /**
   * Move the integration branch's work on to the mainline.
   *
   * The one operation in this service that touches the user's checkout, which
   * is why it is a button and never a consequence of anything finishing. Two
   * outcomes are possible and the difference is not ours to choose:
   *
   *  - The mainline has not moved since the integration branch forked, so this
   *    is a fast-forward: no merge commit, no conflict possible, and
   *    `--ff-only` makes git refuse rather than improvise if that turns out to
   *    be untrue between the check and the command.
   *  - The mainline HAS moved, so promoting means a real merge with a real
   *    chance of conflict — in the user's working copy, mid-whatever-they-are-
   *    doing. That is exactly what this service refuses to do anywhere else, so
   *    it opens a pull request and leaves the merge to a place with a UI for it.
   *
   * A dirty checkout blocks both: `merge --ff-only` can fail partway through
   * with local modifications in the way, and nothing here is worth risking a
   * user's uncommitted work over.
   */
  async syncMainline(workspaceId: string): Promise<MainlineSyncResult> {
    const status = await this.mainlineStatus(workspaceId)
    if (!status) throw new Error('This workspace has no git repository to sync.')

    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)

    const base: MainlineSyncResult = {
      outcome: 'up-to-date',
      baseBranch: status.baseBranch,
      integrationBranch: status.integrationBranch,
      commitCount: 0
    }

    if (!status.exists || status.ahead === 0) return base

    const git = simpleGit(workspace.repoPath)

    if (status.behind === 0) {
      // Only the fast-forward path cares: it moves the checkout's HEAD. The PR
      // path below never touches the working tree, so a dirty one is irrelevant
      // there — and blocking it would be a refusal with no reason behind it.
      if (status.primaryTreeDirty) {
        return {
          ...base,
          outcome: 'blocked',
          reason:
            `Your checkout has uncommitted changes. Commit or stash them, then sync — ` +
            `${status.integrationBranch} is not going anywhere.`
        }
      }
      try {
        await git.raw(['merge', '--ff-only', status.integrationBranch])
        landLog.info(
          `[mainline] fast-forwarded ${status.baseBranch} to ${status.integrationBranch} ` +
            `(${status.ahead} commit(s))`
        )
        return { ...base, outcome: 'fast-forwarded', commitCount: status.ahead }
      } catch (err) {
        // Something moved between the count and the merge, or the tree was not
        // as clean as `git status` suggested. Never retried as a real merge.
        return {
          ...base,
          outcome: 'blocked',
          reason: `Fast-forward refused: ${(err as Error).message}`
        }
      }
    }

    return this.openMainlinePr(workspaceId, workspace.repoPath, status, base)
  }

  /**
   * Diverged: promote by pull request instead of merging into the checkout.
   *
   * Best-effort push for the same reason `landIndependent` pushes best-effort —
   * a local-only repo is a normal setup — but here a failed push means the PR
   * cannot exist at all, so unlike landing it is reported rather than shrugged off.
   */
  private async openMainlinePr(
    workspaceId: string,
    repoPath: string,
    status: MainlineSyncStatus,
    base: MainlineSyncResult
  ): Promise<MainlineSyncResult> {
    if (!githubService.isConfigured(workspaceId)) {
      return {
        ...base,
        outcome: 'blocked',
        reason:
          `${status.baseBranch} has ${status.behind} commit(s) ${status.integrationBranch} ` +
          `does not, so this is a merge rather than a fast-forward. Connect GitHub to open a ` +
          `pull request, or merge ${status.integrationBranch} yourself.`
      }
    }

    const git = simpleGit(repoPath)
    try {
      await git.push('origin', status.integrationBranch, ['--set-upstream'])
    } catch (err) {
      return {
        ...base,
        outcome: 'blocked',
        reason: `Could not push ${status.integrationBranch}: ${(err as Error).message}`
      }
    }

    try {
      const pr = await githubService.createPullRequest({
        workspaceId,
        repoPath,
        head: status.integrationBranch,
        base: status.baseBranch,
        title: `Merge ${status.integrationBranch} into ${status.baseBranch}`,
        body:
          `${status.ahead} commit(s) landed by completed blueprints.` +
          (status.humanReviewCount > 0
            ? `\n\n⚠️ ${status.humanReviewCount} of them were landed by a blueprint that ` +
              `completed without being fully verified (tagged \`human-review-needed\`).`
            : '')
      })
      landLog.info(`[mainline] PR ${pr.prUrl} opened for ${status.integrationBranch}`)
      return {
        ...base,
        outcome: 'pull-request',
        prUrl: pr.prUrl,
        prNumber: pr.prNumber
      }
    } catch (err) {
      return {
        ...base,
        outcome: 'blocked',
        reason: `Pull request could not be opened: ${(err as Error).message}`
      }
    }
  }

  // ── Branch GC ─────────────────────────────────────────────────────

  /**
   * Reclaim tracks whose work has already reached the mainline.
   *
   * Branch-per-chat plus branch-per-blueprint means a workspace accumulates
   * hundreds of dead refs over a few months, and `git branch` stops being
   * readable. Only landed tracks are eligible, and only clean ones: a landed
   * track that is dirty again has new work in it, which is never ours to
   * delete.
   *
   * @returns how many tracks were reclaimed.
   */
  /**
   * Run branch GC across every workspace on a timer.
   *
   * Same shape and same reasoning as the idle reaper: run it only at boot and
   * the policy quietly becomes "whenever you restart", so a long-lived session
   * accumulates every landed branch it ever produced. Idempotent; `unref()` so
   * a pending tick is never what keeps the process alive.
   */
  startBranchGc(intervalMs: number = BRANCH_GC_INTERVAL_MS): void {
    if (this.gcTimer) return
    this.gcTimer = setInterval(() => {
      void this.gcAllWorkspaces()
    }, intervalMs)
    this.gcTimer.unref?.()
  }

  /** Stop periodic branch GC. Safe when it was never started. */
  stopBranchGc(): void {
    if (!this.gcTimer) return
    clearInterval(this.gcTimer)
    this.gcTimer = null
  }

  /** One GC pass over every workspace. Failures are per-workspace, never fatal. */
  async gcAllWorkspaces(): Promise<number> {
    let total = 0
    let workspaces: { id: string }[]
    try {
      workspaces = workspaceRepository.findAll()
    } catch (err) {
      landLog.warn(`[gc] workspace list unavailable: ${(err as Error).message}`)
      return 0
    }
    for (const ws of workspaces) {
      try {
        total += await this.gcLandedTracks(ws.id)
      } catch (err) {
        landLog.warn(`[gc] workspace ${ws.id} failed: ${(err as Error).message}`)
      }
    }
    if (total > 0) landLog.info(`[gc] reclaimed ${total} landed track(s)`)
    return total
  }

  async gcLandedTracks(workspaceId: string): Promise<number> {
    const workspace = workspaceRepository.findById(workspaceId)
    if (!workspace) return 0

    const repoGit = simpleGit(workspace.repoPath)

    let reclaimed = 0
    for (const row of trackRepository.findLanded(workspaceId)) {
      if (row.status === 'conflicted') continue
      if (existsSync(row.path) && (await trackService.hasUncommittedWork(row.path))) {
        landLog.info(`[gc] ${row.branchName} landed but has new uncommitted work — keeping`)
        continue
      }
      if (!(await this.isReclaimable(repoGit, row))) continue

      // Removes the worktree and deregisters it; without this git refuses to
      // delete a branch that is still checked out somewhere.
      const removed = await trackService.discard(row.id)
      if (!removed) continue

      try {
        await simpleGit(workspace.repoPath).deleteLocalBranch(row.branchName, true)
        landLog.info(`[gc] deleted landed branch ${row.branchName}`)
      } catch (err) {
        landLog.warn(
          `[gc] worktree for ${row.branchName} removed but the branch could not be deleted: ` +
            `${(err as Error).message}`
        )
      }
      reclaimed++
    }
    return reclaimed
  }
}

export const landingService = new LandingService()
