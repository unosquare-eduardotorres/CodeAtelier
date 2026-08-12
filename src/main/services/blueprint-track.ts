/**
 * The track a blueprint run works in.
 *
 * BUILD used to run every one of its (up to six) parallel agents with
 * `cwd = workspace.repoPath` — the branch the *user* is sitting on, with the
 * user's uncommitted edits in it. The only protection was a process-wide lock
 * that serialised blueprint against chat, which bought safety by giving up the
 * parallelism the whole subsystem exists for, and did nothing about the fact
 * that the output landed in someone's working copy either way.
 *
 * A blueprint run now owns a branch and a worktree of its own, exactly like a
 * chat does. The visible consequence is worth naming: build output arrives as a
 * branch you merge, not as edits already sitting in your checkout.
 *
 * BUILD and VERIFY share one track, keyed on the blueprint id — VERIFY has to
 * see what BUILD wrote, and its deterministic quality gates have to run where
 * that code actually is.
 */

import simpleGit from 'simple-git'
import log from 'electron-log'
import { trackService, TrackConflictError } from './track.service'
import { trackRepository } from '../db/repositories/track.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import type { ExecutionTarget } from '../../shared/track-types'
import type { BlueprintBranchChoice } from '../../shared/blueprint-types'

const trackLog = log.scope('blueprint-track')

/** Owner kind + id every blueprint phase resolves its execution path by. */
export function blueprintTrackOwner(blueprintId: string): {
  ownerKind: 'blueprint'
  ownerId: string
} {
  return { ownerKind: 'blueprint', ownerId: blueprintId }
}

/**
 * Branch name for a blueprint run.
 *
 * Slug for a human scanning `git branch`, id suffix for uniqueness — two
 * blueprints with the same title are common and must not collide, since git
 * allows a branch in exactly one worktree repo-wide.
 */
export function blueprintTrackBranch(blueprintId: string, title: string | undefined): string {
  const slug = (title || 'blueprint')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  return `blueprint/${slug || 'run'}-${blueprintId.slice(0, 8)}`
}

/** Where a blueprint runs, plus why it is not isolated when it is not. */
export interface BlueprintExecutionTarget extends ExecutionTarget {
  /**
   * Null when the requested branch choice was honoured exactly.
   *
   * Isolation being declined used to be a log line, which meant the user asked
   * for a branch, silently got the shared checkout, and found out when build
   * output appeared in their working copy. Carrying the reason back lets the
   * caller say so.
   */
  reason: string | null
}

/**
 * The branch choice a blueprint was created with.
 *
 * Read defensively: `settings_json` is free-form and every blueprint created
 * before branch selection existed has no `branchChoice` at all — for which
 * `auto` is both the old behaviour and the right answer.
 */
export function readBranchChoice(settings: Record<string, unknown>): BlueprintBranchChoice {
  const raw = settings.branchChoice as Partial<BlueprintBranchChoice> | undefined
  const mode = raw?.mode
  if (mode !== 'fork' && mode !== 'takeover' && mode !== 'primary') return { mode: 'auto' }
  return {
    mode,
    branch: typeof raw?.branch === 'string' && raw.branch ? raw.branch : undefined,
    name: typeof raw?.name === 'string' && raw.name ? raw.name : undefined
  }
}

/**
 * Does this repository have a first commit yet?
 *
 * An unborn HEAD has no branches to fork from and nothing to isolate: git
 * rejects `worktree add -b x <path> <base>` outright. Deliberately not
 * `--quiet`, which would silence stderr — and simple-git only rejects when a
 * failing git wrote something there.
 */
export async function repoHasCommits(repoPath: string): Promise<boolean> {
  try {
    await simpleGit(repoPath).revparse(['--verify', 'HEAD'])
    return true
  } catch {
    return false
  }
}

/**
 * Give a blueprint run its own working tree, or say why it could not have one.
 *
 * Never throws. Every failure mode here — the workspace opted out of branching,
 * the branch is held by other work, the repo has no commits, git refused —
 * degrades to the primary tree, which is exactly where blueprints ran before
 * this existed. Failing the whole BUILD phase because a worktree could not be
 * created would be a regression; running in the shared tree is merely the old
 * behaviour, and the caller takes the primary-tree lock when `isolated` comes
 * back false.
 */
export async function ensureBlueprintTrack(params: {
  blueprintId: string
  workspaceId: string
  /** The workspace's primary tree. Stays the workspace identity key throughout. */
  workspacePath: string
}): Promise<BlueprintExecutionTarget> {
  const { blueprintId, workspaceId, workspacePath } = params
  const primary = (reason: string | null): BlueprintExecutionTarget => ({
    path: workspacePath,
    branchName: null,
    isolated: false,
    reason
  })

  try {
    // Same opt-out as chats: an explicit `false` means the user does not want
    // us creating branches in this workspace. Anything else is a yes.
    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings.gitAutoBranch === false) {
      trackLog.info(
        `[ensure] workspace ${workspaceId} opted out of auto-branching — ` +
          `blueprint ${blueprintId} runs in the primary tree`
      )
      return primary('this workspace has automatic branching turned off')
    }

    const blueprint = blueprintRepository.findById(blueprintId)
    const choice = readBranchChoice(blueprint?.settingsJson ?? {})

    if (choice.mode === 'primary') {
      trackLog.info(`[ensure] blueprint ${blueprintId} was set to run in the primary tree`)
      return primary('this blueprint was set to run in the workspace checkout')
    }

    // Manufacturing a first commit in someone else's repository to make a
    // worktree possible is far too surprising to do quietly, and there is
    // nothing to isolate from until there is one.
    if (!(await repoHasCommits(workspacePath))) {
      trackLog.info(`[ensure] ${workspacePath} has no commits — blueprint runs in the primary tree`)
      return primary('this repository has no commits yet')
    }

    const autoName = blueprintTrackBranch(blueprintId, blueprint?.title)
    let branchName = autoName
    let baseBranch: string | undefined

    if (choice.mode === 'fork') {
      branchName = choice.name ?? autoName
      baseBranch = choice.branch
    } else if (choice.mode === 'takeover') {
      if (choice.branch) branchName = choice.branch
      else trackLog.warn(`[ensure] blueprint ${blueprintId}: takeover with no branch — using auto`)
    }

    // Takeover is a handoff, not a checkout: the branch may already belong to a
    // chat, and the point is that the blueprint inherits that tree with the
    // files the chat left in it rather than a fresh one.
    if (choice.mode === 'takeover' && choice.branch) {
      const holder = trackRepository.findByBranch(workspaceId, branchName)
      const alreadyOurs = holder?.ownerKind === 'blueprint' && holder.ownerId === blueprintId
      if (holder && !alreadyOurs) {
        const outcome = trackService.transferOwner(holder.id, {
          ownerKind: 'blueprint',
          ownerId: blueprintId
        })
        if (outcome.ok) {
          trackLog.info(
            `[ensure] blueprint ${blueprintId} took over ${branchName} at ${outcome.track.path}`
          )
          return {
            path: outcome.track.path,
            branchName: outcome.track.branchName,
            isolated: true,
            reason: null
          }
        }
        if (outcome.reason === 'busy') {
          const who = outcome.holder.label ?? outcome.holder.ownerId ?? 'other work'
          return primary(`${who} is using ${branchName} right now — ${outcome.because}`)
        }
        // 'no-tree' or 'absent': the bookkeeping outlived the directory, so fall
        // through and let ensureTrack rebuild one for the branch.
      }
    }

    const target = await trackService.ensureTrack({
      ownerKind: 'blueprint',
      ownerId: blueprintId,
      workspaceId,
      repoPath: workspacePath,
      branchName,
      baseBranch
    })

    if (target.isolated) {
      trackLog.info(`[ensure] blueprint ${blueprintId} → ${target.path} (${target.branchName})`)
      return { ...target, reason: null }
    }

    // Rule 3: the workspace checkout is sitting on this branch, so git will not
    // allow a second worktree for it. Correct, and invisible unless said out
    // loud — the user picked a branch and is getting the shared tree.
    trackLog.info(
      `[ensure] blueprint ${blueprintId} runs in the primary tree — it already holds ${branchName}`
    )
    return {
      ...target,
      reason: `your workspace checkout is already on ${branchName}, so it cannot also be checked out separately`
    }
  } catch (err) {
    if (err instanceof TrackConflictError) {
      trackLog.warn(
        `[ensure] blueprint ${blueprintId}: branch ${err.branchName} is held by other work — ` +
          `running in the primary tree instead`
      )
      return primary(`branch ${err.branchName} is held by other work`)
    }
    trackLog.error(
      `[ensure] blueprint ${blueprintId}: could not create a worktree ` +
        `(${(err as Error).message}) — running in the primary tree instead`
    )
    return primary(`a working tree could not be created (${(err as Error).message})`)
  }
}

/**
 * Where a blueprint run is executing right now, without creating anything.
 *
 * VERIFY's entry point: BUILD already created the tree, and a re-run of VERIFY
 * long after the fact should follow the work to wherever it actually is rather
 * than resurrecting a branch. Falls back to the primary tree, which is correct
 * when BUILD never had a track or the track has since been landed.
 */
export function resolveBlueprintTrack(blueprintId: string, workspacePath: string): ExecutionTarget {
  return trackService.resolveTrack('blueprint', blueprintId, workspacePath)
}
