import { ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import simpleGit from 'simple-git'
import { IPC_CHANNELS } from '../../shared/constants'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { agentSyncService } from '../services/agent-sync.service'
import { brainService } from '../services/brain.service'
import { dbLogger } from '../logger'

export function registerWorkspaceIpc(): void {
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async (event) => {
    validateSender(event)
    return workspaceRepository.findAll()
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CREATE,
    async (event, args: { name: string; repoPath: string }) => {
      validateSender(event)

      // Input validation
      if (!args || typeof args !== 'object') {
        throw new Error('Invalid arguments')
      }

      const { name, repoPath } = args

      if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
        throw new Error('Invalid workspace name: must be a non-empty string (max 255 chars)')
      }

      if (typeof repoPath !== 'string' || repoPath.trim().length === 0) {
        throw new Error('Invalid repository path')
      }

      // Normalize path to prevent traversal attacks
      const normalizedPath = resolve(repoPath)

      // Validate path exists
      if (!existsSync(normalizedPath)) {
        throw new Error(`Path does not exist: ${normalizedPath}`)
      }

      // Validate it's a git repository
      try {
        const git = simpleGit(normalizedPath)
        const isRepo = await git.checkIsRepo()
        if (!isRepo) {
          throw new Error(`Not a Git repository: ${normalizedPath}`)
        }

        // Try to get remote URL
        let gitRemoteUrl: string | undefined
        try {
          const remotes = await git.getRemotes(true)
          const origin = remotes.find((r) => r.name === 'origin')
          gitRemoteUrl = origin?.refs?.fetch
        } catch {
          // No remote is fine
        }

        return workspaceRepository.create(
          name.trim() || basename(normalizedPath),
          normalizedPath,
          gitRemoteUrl
        )
      } catch (error) {
        if (error instanceof Error && error.message.includes('Not a Git repository')) {
          throw error
        }
        throw new Error(`Failed to validate Git repository: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid workspace ID')
    }

    const workspace = workspaceRepository.updateLastOpened(args.id)
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.id}`)
    }

    // Auto-sync: import NEW agents/skills from workspace YAMLs into DB
    try {
      const syncResult = agentSyncService.autoSyncNewEntries(workspace.repoPath)
      if (syncResult.imported > 0 || syncResult.skillsImported > 0) {
        dbLogger.info(
          `Workspace open auto-sync: imported ${syncResult.imported} specialists, ${syncResult.skillsImported} skills`
        )
      }
    } catch (e) {
      dbLogger.warn('Auto-sync on workspace open failed:', e)
    }

    // Auto-initialize brain directory for this workspace
    try {
      brainService.initialize(workspace.repoPath)
      dbLogger.info('Brain directory initialized for workspace:', workspace.repoPath)
    } catch (e) {
      dbLogger.warn('Brain initialization failed:', e)
    }

    return workspace
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid workspace ID')
    }

    workspaceRepository.delete(args.id)
  })

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_DIRECTORY, async (event) => {
    validateSender(event)

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Directory'
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    return result.filePaths[0]
  })
}
