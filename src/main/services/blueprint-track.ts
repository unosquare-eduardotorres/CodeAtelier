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

import log from 'electron-log'
import { trackService, TrackConflictError } from './track.service'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { blueprintRepository } from '../db/repositories/blueprint.repository'
import type { ExecutionTarget } from '../../shared/track-types'

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

/**
 * Give a blueprint run its own working tree, or say why it could not have one.
 *
 * Never throws. Every failure mode here — the workspace opted out of branching,
 * the branch is held by other work, git refused — degrades to the primary tree,
 * which is exactly where blueprints ran before this existed. Failing the whole
 * BUILD phase because a worktree could not be created would be a regression;
 * running in the shared tree is merely the old behaviour, and the caller takes
 * the primary-tree lock when `isolated` comes back false.
 */
export async function ensureBlueprintTrack(params: {
  blueprintId: string
  workspaceId: string
  /** The workspace's primary tree. Stays the workspace identity key throughout. */
  workspacePath: string
}): Promise<ExecutionTarget> {
  const { blueprintId, workspaceId, workspacePath } = params
  const primary: ExecutionTarget = { path: workspacePath, branchName: null, isolated: false }

  try {
    // Same opt-out as chats: an explicit `false` means the user does not want
    // us creating branches in this workspace. Anything else is a yes.
    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings.gitAutoBranch === false) {
      trackLog.info(
        `[ensure] workspace ${workspaceId} opted out of auto-branching — ` +
          `blueprint ${blueprintId} runs in the primary tree`
      )
      return primary
    }

    const title = blueprintRepository.findById(blueprintId)?.title
    const branchName = blueprintTrackBranch(blueprintId, title)

    const target = await trackService.ensureTrack({
      ownerKind: 'blueprint',
      ownerId: blueprintId,
      workspaceId,
      repoPath: workspacePath,
      branchName
    })

    if (target.isolated) {
      trackLog.info(`[ensure] blueprint ${blueprintId} → ${target.path} (${target.branchName})`)
    } else {
      trackLog.info(
        `[ensure] blueprint ${blueprintId} runs in the primary tree — ` +
          `it already holds ${branchName}`
      )
    }
    return target
  } catch (err) {
    if (err instanceof TrackConflictError) {
      trackLog.warn(
        `[ensure] blueprint ${blueprintId}: branch ${err.branchName} is held by other work — ` +
          `running in the primary tree instead`
      )
    } else {
      trackLog.error(
        `[ensure] blueprint ${blueprintId}: could not create a worktree ` +
          `(${(err as Error).message}) — running in the primary tree instead`
      )
    }
    return primary
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
