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
import type { LandingResult, TrackLandingMode, WorkTrack } from '../../shared/track-types'

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
  return `integration/${slug || 'main'}`
}

/** Owner key for the worktree this service merges in. One per workspace. */
function integrationOwnerId(workspaceId: string): string {
  return `integration:${workspaceId}`
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
      ? this.landIntegration(track, commitHash)
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
    const status = await git.status()
    const changed = [
      ...status.modified,
      ...status.created,
      ...status.not_added,
      ...status.deleted,
      ...status.renamed.map((r) => r.to)
    ]
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
    let mergeError: Error | null = null
    try {
      await git.raw(['merge', '--no-ff', '--no-edit', track.branchName])
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

    let reclaimed = 0
    for (const row of trackRepository.findLanded(workspaceId)) {
      if (row.status === 'conflicted') continue
      if (existsSync(row.path) && (await trackService.hasUncommittedWork(row.path))) {
        landLog.info(`[gc] ${row.branchName} landed but has new uncommitted work — keeping`)
        continue
      }

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
