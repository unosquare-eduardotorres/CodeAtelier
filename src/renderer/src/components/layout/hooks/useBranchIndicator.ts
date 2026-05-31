/**
 * useBranchIndicator — tracks current git branch and repo status.
 */
import { useState, useEffect } from 'react'
import type { Conversation, Workspace } from '../../../../../shared/types'

interface BranchInfo {
  currentBranch: string | null
  isGitRepo: boolean
}

export function useBranchIndicator(
  activeWorkspace: Workspace | null,
  activeConversation: Conversation | null,
  repoInfo: { isRepo: boolean; currentBranch: string } | null
): BranchInfo {
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [isGitRepo, setIsGitRepo] = useState(false)

  useEffect(() => {
    if (!activeWorkspace) {
      setCurrentBranch(null)
      setIsGitRepo(false)
      return
    }
    if (activeConversation?.branchName) {
      setCurrentBranch(activeConversation.branchName)
      setIsGitRepo(true)
    } else if (repoInfo) {
      setIsGitRepo(repoInfo.isRepo)
      setCurrentBranch(repoInfo.isRepo ? repoInfo.currentBranch : null)
    } else {
      window.api.getRepoInfo({ workspaceId: activeWorkspace.id }).then((info) => {
        setIsGitRepo(info.isRepo)
        setCurrentBranch(info.isRepo ? info.currentBranch : null)
      })
    }
  }, [activeWorkspace?.id, activeConversation?.id, activeConversation?.branchName, repoInfo])

  return { currentBranch, isGitRepo }
}
