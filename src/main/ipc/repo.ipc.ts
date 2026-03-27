import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { repoService } from '../services/repo.service'
import { workspaceRepository, fileChangeRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

export function registerRepoIpc(): void {
  // Initialize a git repo at the workspace path
  ipcMain.handle(
    IPC_CHANNELS.REPO_INIT,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('Missing workspaceId')

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      await repoService.initRepo(workspace.repoPath)

      // Update workspace record
      const settings = workspaceRepository.getSettings(args.workspaceId)
      workspaceRepository.updateSettings(args.workspaceId, { ...settings })
    }
  )

  // Set or update the origin remote URL
  ipcMain.handle(
    IPC_CHANNELS.REPO_SET_REMOTE,
    async (event, args: { workspaceId: string; remoteUrl: string }) => {
      validateSender(event)
      if (!args?.workspaceId || !args?.remoteUrl) {
        throw new Error('Missing workspaceId or remoteUrl')
      }

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      await repoService.setRemote(workspace.repoPath, args.remoteUrl)
    }
  )

  // Get repo info (isRepo, hasRemote, remoteUrl, currentBranch)
  ipcMain.handle(
    IPC_CHANNELS.REPO_GET_INFO,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args?.workspaceId) throw new Error('Missing workspaceId')

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      return repoService.getRepoInfo(workspace.repoPath)
    }
  )

  // Check if a conversation has unsaved changes
  ipcMain.handle(
    IPC_CHANNELS.REPO_HAS_UNSAVED_CHANGES,
    async (event, args: { conversationId: string }) => {
      validateSender(event)
      if (!args?.conversationId) throw new Error('Missing conversationId')

      // Get tracked files from DB
      const fileChanges = fileChangeRepository.findByConversation(args.conversationId)
      const trackedFiles = fileChanges.map((fc) => fc.filePath)

      // Find workspace path via conversation
      const { conversationRepository } = await import('../db/repositories')
      const conversation = conversationRepository.findById(args.conversationId)
      if (!conversation) return { hasChanges: false, fileCount: 0, files: [] }

      const workspace = workspaceRepository.findById(conversation.workspaceId)
      if (!workspace) return { hasChanges: false, fileCount: 0, files: [] }

      return repoService.hasUncommittedChanges(workspace.repoPath, trackedFiles)
    }
  )
}
