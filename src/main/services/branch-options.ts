/**
 * What the blueprint branch picker is allowed to offer.
 *
 * Shaping only. The git read and the repository reads live in the
 * `blueprint:branchOptions` handler; the decisions worth testing are here,
 * because the handler needs Electron's `ipcMain`, a workspace on disk and a
 * live database before it will run at all.
 *
 * The governing rule is that held branches are *listed*, never filtered out. A
 * branch the user can see in their own terminal quietly missing from this list
 * reads as a bug in the picker, and leaves them with no way to find out who has
 * it. Listing it with its holder answers the real question — "why can't I pick
 * this one" — and lets the modal decide whether to disable it.
 */

import type { TrackOwnerKind } from '../../shared/track-types'
import type { BlueprintBranchOptions } from '../../shared/blueprint-types'

/** The `work_tracks` fields the picker needs. */
export interface HeldBranch {
  branchName: string
  ownerKind: TrackOwnerKind
  /** Null for a retained track: the work outlived its owner. */
  ownerId: string | null
}

/**
 * The answer for a repository with no commits.
 *
 * An unborn HEAD has no branches to fork from and nothing to isolate — git
 * rejects `worktree add` outright. Saying so explicitly lets the modal
 * preselect `primary` with a reason, instead of showing an empty list that
 * looks like a failed load.
 */
export const NO_COMMITS_BRANCH_OPTIONS: BlueprintBranchOptions = {
  branches: [],
  repoHasCommits: false,
  currentBranch: null
}

export function buildBranchOptions(params: {
  repoHasCommits: boolean
  /** Local branch names, in the order the picker should show them. */
  local: readonly string[]
  /** The workspace checkout's branch. */
  current: string | null
  tracks: readonly HeldBranch[]
  /** Resolves a chat owner id to its title. Returns null when unresolvable. */
  chatTitle: (conversationId: string) => string | null
}): BlueprintBranchOptions {
  const { repoHasCommits, local, current, tracks, chatTitle } = params
  if (!repoHasCommits) return NO_COMMITS_BRANCH_OPTIONS

  // Last writer wins, which only matters if the UNIQUE(workspace, branch)
  // constraint were ever absent. Building the map once keeps this linear in the
  // number of branches rather than quadratic — repos with thousands of branches
  // are ordinary.
  const heldByBranch = new Map(tracks.map((t) => [t.branchName, t]))

  return {
    repoHasCommits: true,
    currentBranch: current || null,
    branches: local.map((name) => {
      const held = heldByBranch.get(name)
      return {
        name,
        isPrimaryHead: name === current,
        heldBy: held
          ? {
              ownerKind: held.ownerKind,
              ownerId: held.ownerId,
              // A chat's id means nothing to the user; its title is what they
              // named it. Non-chat owners have no better handle than their id,
              // and a retained track has no owner to name at all.
              label: held.ownerId
                ? held.ownerKind === 'chat'
                  ? (chatTitle(held.ownerId) ?? held.ownerId)
                  : held.ownerId
                : null
            }
          : null
      }
    })
  }
}
