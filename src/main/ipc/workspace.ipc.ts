import { ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import simpleGit from 'simple-git'
import { IPC_CHANNELS } from '../../shared/constants'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
import { agentSyncService } from '../services/agent-sync.service'
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

      // Check if it's a git repository (no longer required)
      let isGitRepo = false
      let gitRemoteUrl: string | undefined
      try {
        const git = simpleGit(normalizedPath)
        isGitRepo = await git.checkIsRepo()
        if (isGitRepo) {
          try {
            const remotes = await git.getRemotes(true)
            const origin = remotes.find((r) => r.name === 'origin')
            gitRemoteUrl = origin?.refs?.fetch
          } catch {
            // No remote is fine
          }
        }
      } catch {
        // Not a repo — fine, we allow non-git directories
      }

      return workspaceRepository.create(
        name.trim() || basename(normalizedPath),
        normalizedPath,
        gitRemoteUrl,
        isGitRepo
      )
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

    // Load auth settings for this workspace (determines CLI vs SDK execution path)
    try {
      const { authProvider } = await import('../services/auth-provider')
      authProvider.loadFromWorkspace(workspace.repoPath)
    } catch (e) {
      dbLogger.warn('Failed to load auth settings:', e)
    }

    // Auto memory is DB-backed — no directory initialization needed

    return workspace
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid workspace ID')
    }

    workspaceRepository.delete(args.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GET_SETTINGS,
    async (event, args: { workspaceId: string }) => {
      validateSender(event)
      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }
      return workspaceRepository.getSettings(args.workspaceId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UPDATE_SETTINGS,
    async (event, args: { workspaceId: string; settings: Record<string, unknown> }) => {
      validateSender(event)
      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }
      if (!args.settings || typeof args.settings !== 'object' || Array.isArray(args.settings)) {
        throw new Error('Invalid settings object')
      }
      // Merge with existing settings to avoid overwriting fields set by other services
      // (e.g., githubTokenEncrypted set by github.service)
      const existing = workspaceRepository.getSettings(args.workspaceId)
      const merged = { ...existing, ...args.settings }
      return workspaceRepository.updateSettings(args.workspaceId, merged)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UPDATE_AUTH,
    async (
      event,
      args: { workspaceId: string; authMode: string; anthropicApiKey?: string }
    ) => {
      validateSender(event)
      if (!args || typeof args.workspaceId !== 'string' || args.workspaceId.trim().length === 0) {
        throw new Error('Invalid workspace ID')
      }
      if (args.authMode !== 'claude-max' && args.authMode !== 'api-key') {
        throw new Error('Invalid auth mode — must be "claude-max" or "api-key"')
      }

      // Merge auth settings with existing workspace settings
      const existing = workspaceRepository.getSettings(args.workspaceId)
      const merged = {
        ...existing,
        authMode: args.authMode,
        // Only store API key if auth mode is api-key, otherwise clear it
        anthropicApiKey: args.authMode === 'api-key' ? args.anthropicApiKey : undefined
      }
      workspaceRepository.updateSettings(args.workspaceId, merged)

      // Reload auth provider for the active workspace
      const workspace = workspaceRepository.findAll().find((w) => w.id === args.workspaceId)
      if (workspace) {
        const { authProvider } = await import('../services/auth-provider')
        authProvider.loadFromWorkspace(workspace.repoPath)
      }

      return { success: true }
    }
  )

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
