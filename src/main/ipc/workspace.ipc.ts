import { ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, basename } from 'node:path'
import simpleGit from 'simple-git'
import { IPC_CHANNELS } from '../../shared/constants'
import { workspaceRepository } from '../db/repositories'
import { repoService } from '../services/repo.service'
import { validateSender } from './validate-sender'
import { agentSyncService } from '../services/agent-sync.service'
import { fileWatcherService } from '../services/file-watcher.service'
import { chatAgentService } from '../services/chat-agent.service'
import { dbLogger } from '../logger'
import { getDatabase } from '../db/index'

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

      const workspace = workspaceRepository.create(
        name.trim() || basename(normalizedPath),
        normalizedPath,
        gitRemoteUrl,
        isGitRepo
      )

      // Phase 2 refactor: seed a pending Project Specialist row so the user
      // can build it on first open. Idempotent — migration 66 already does
      // this for pre-existing workspaces; this covers workspaces added
      // AFTER the migration ran.
      try {
        const db = getDatabase()
        const existing = db
          .prepare(`SELECT id FROM specialists WHERE workspace_id = ?`)
          .get(workspace.id) as { id: string } | undefined
        if (!existing) {
          db.prepare(
            `INSERT INTO specialists (workspace_id, agent_id, display_name, icon, color,
               prompt, priority, is_active, build_status, created_at, updated_at)
             VALUES (?, ?, ?, '🔧', '#6366F1', '', 1, 1, 'pending', datetime('now'), datetime('now'))`
          ).run(
            workspace.id,
            `workspace-specialist-${workspace.id}`,
            `${workspace.name} Specialist`
          )
          dbLogger.info(`Seeded pending Project Specialist for workspace ${workspace.id}`)
        }
      } catch (err) {
        dbLogger.warn('Failed to seed Project Specialist on workspace create:', err)
      }

      // Auto-init git repo if not already a git repository
      if (!isGitRepo) {
        try {
          await repoService.initRepo(normalizedPath)
          dbLogger.info(`Auto-initialized git repo at ${normalizedPath}`)
        } catch (err) {
          dbLogger.warn('Auto-init git failed (non-fatal):', err)
        }
      }

      return workspace
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

    // Start file watcher if Code Graph or Semantic Search is enabled
    try {
      const wsSettings = JSON.parse(workspace.settingsJson || '{}')
      if (wsSettings.repomapEnabled || wsSettings.semanticSearchEnabled) {
        fileWatcherService.start(workspace.id, workspace.repoPath, {
          codeGraphEnabled: !!wsSettings.repomapEnabled,
          semanticSearchEnabled: !!wsSettings.semanticSearchEnabled
        })
      }
    } catch (e) {
      dbLogger.warn('Failed to start file watcher on workspace open:', e)
    }

    return workspace
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, async (event, args: { id: string }) => {
    validateSender(event)

    if (!args || typeof args.id !== 'string' || args.id.trim().length === 0) {
      throw new Error('Invalid workspace ID')
    }

    fileWatcherService.stop(args.id)
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
      const result = workspaceRepository.updateSettings(args.workspaceId, merged)

      // Update file watcher based on new settings
      try {
        const ws = workspaceRepository.findById(args.workspaceId)
        if (ws) {
          const s = merged as Record<string, unknown>
          if (s.repomapEnabled || s.semanticSearchEnabled) {
            fileWatcherService.start(args.workspaceId, ws.repoPath, {
              codeGraphEnabled: !!s.repomapEnabled,
              semanticSearchEnabled: !!s.semanticSearchEnabled
            })
          } else {
            fileWatcherService.stop(args.workspaceId)
          }
        }
      } catch (e) {
        dbLogger.warn('Failed to update file watcher on settings change:', e)
      }

      // ── Restart agent session when LLM provider changes ──
      // The running AgentSessionService caches llmProvider at start().
      // If it changes, we must restart so the new provider takes effect.
      try {
        const oldProvider = (existing.llmProvider as string) ?? 'claude'
        const newProvider = (merged.llmProvider as string) ?? 'claude'

        if (oldProvider !== newProvider && chatAgentService.isRunning()) {
          const ws = workspaceRepository.findById(args.workspaceId)
          if (ws && chatAgentService.getWorkspacePath() === ws.repoPath) {
            dbLogger.info(
              `[workspace:settings] LLM provider changed: ${oldProvider} → ${newProvider} — restarting agent session`
            )
            await chatAgentService.start(ws.repoPath)
          }
        }
      } catch (e) {
        dbLogger.warn('Failed to restart agent after LLM provider change:', e)
      }

      return result
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UPDATE_AUTH,
    async (event, args: { workspaceId: string; authMode: string; anthropicApiKey?: string }) => {
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

  // ── External MCP prerequisite check ──
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_CHECK_EXTERNAL_MCP,
    async (event, args: { command: string }) => {
      validateSender(event)
      if (!args || typeof args.command !== 'string' || args.command.trim().length === 0) {
        throw new Error('Invalid command')
      }
      // Sanitize: only allow simple command names (no slashes, spaces, or shell metacharacters)
      if (!/^[a-zA-Z0-9_-]+$/.test(args.command)) {
        throw new Error('Invalid command name')
      }
      try {
        const result = execSync(`which ${args.command}`, { stdio: 'pipe', timeout: 3000 })
        return { available: true, path: result.toString().trim() }
      } catch {
        return { available: false }
      }
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
