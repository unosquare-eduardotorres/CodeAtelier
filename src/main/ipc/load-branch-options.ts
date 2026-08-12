/**
 * Read the branch list a picker may offer, for one workspace.
 *
 * Extracted from the `blueprint:branchOptions` handler because chats need the
 * exact same answer: which branches exist, which one the workspace checkout is
 * sitting on, and who is holding each of the rest. Two handlers, one IO body —
 * a second copy would drift, and the holder labels are the part that matters.
 *
 * Shaping stays in `branch-options.ts`, which is pure and unit-tested. This is
 * only the IO its header says belongs in the handler.
 */

import { workspaceRepository, conversationRepository } from '../db/repositories'
import { trackRepository } from '../db/repositories/track.repository'
import { repoService } from '../services/repo.service'
import { repoHasCommits } from '../services/blueprint-track'
import { buildBranchOptions, NO_COMMITS_BRANCH_OPTIONS } from '../services/branch-options'
import type { BlueprintBranchOptions } from '../../shared/blueprint-types'

export async function loadBranchOptions(workspaceId: string): Promise<BlueprintBranchOptions> {
  const workspace = workspaceRepository.findById(workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  // An unborn HEAD has no branches and nothing to fork from, and git rejects
  // `worktree add` outright — there is no list to build.
  if (!(await repoHasCommits(workspace.repoPath))) return NO_COMMITS_BRANCH_OPTIONS

  const { local, current } = await repoService.listBranches(workspace.repoPath)

  return buildBranchOptions({
    repoHasCommits: true,
    local,
    current,
    tracks: trackRepository.findByWorkspace(workspaceId),
    chatTitle: (id) => conversationRepository.findById(id)?.title ?? null
  })
}
