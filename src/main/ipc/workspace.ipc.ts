import { ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { resolve, basename } from 'node:path'
import simpleGit from 'simple-git'
import { IPC_CHANNELS } from '../../shared/constants'
import { workspaceRepository } from '../db/repositories'
import { repoService } from '../services/repo.service'
import { validateSender } from './validate-sender'
import { requireObject, requireString, requirePlainObject, optionalString } from './validate-args'
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_CREATE
    const args = requireObject(rawArgs, ch)
    const name = requireString(args, 'name', ch)
    const repoPath = requireString(args, 'repoPath', ch)

    if (name.length > 255) {
      throw new Error(`${ch}: workspace name too long (max 255 chars)`)
    }

    // Normalize path to prevent traversal attacks
    const normalizedPath = resolve(repoPath)

    // Validate path exists
    if (!existsSync(normalizedPath)) {
      throw new Error(`Path does not exist: ${normalizedPath}`)
    }

    // Check if this directory is the root of its own git repo (not just nested
    // inside a parent repo). Uses rev-parse --show-toplevel for an exact match.
    let isGitRepo = false
    let gitRemoteUrl: string | undefined
    try {
      const git = simpleGit(normalizedPath)
      const top = (await git.revparse(['--show-toplevel'])).trim()
      isGitRepo = resolve(top) === normalizedPath
      if (isGitRepo) {
        const remotes = await git.getRemotes(true)
        gitRemoteUrl = remotes.find((r) => r.name === 'origin')?.refs?.fetch
      }
    } catch {
      /* not a repo / not the root — auto-init below */
    }

    // Auto-init git repo BEFORE creating workspace so the DB row is born with isGitRepo=true
    if (!isGitRepo) {
      try {
        await repoService.initRepo(normalizedPath)
        isGitRepo = true
        dbLogger.info(`Auto-initialized git repo at ${normalizedPath}`)
      } catch (err) {
        dbLogger.warn('Auto-init git failed (non-fatal):', err)
      }
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
        ).run(workspace.id, `workspace-specialist-${workspace.id}`, `${workspace.name} Specialist`)
        dbLogger.info(`Seeded pending Project Specialist for workspace ${workspace.id}`)
      }
    } catch (err) {
      dbLogger.warn('Failed to seed Project Specialist on workspace create:', err)
    }

    return workspace
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_OPEN
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    const workspace = workspaceRepository.updateLastOpened(id)
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`)
    }

    // Ensure workspace has its own .git (self-heal parent-repo nesting)
    try {
      await repoService.ensureOwnRepo(workspace.repoPath)
    } catch (e) {
      dbLogger.warn('ensureOwnRepo on workspace open failed (non-fatal):', e)
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
      const wsSettings = workspaceRepository.getSettings(workspace.id)
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_DELETE
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)

    // Stop any running sessions for this workspace before deleting
    const { chatAgentService } = await import('../services')
    await chatAgentService.stopForWorkspace(id).catch(() => {
      /* non-fatal: workspace being deleted — session stop is best-effort */
    })

    fileWatcherService.stop(id)
    workspaceRepository.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_SETTINGS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_GET_SETTINGS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    return workspaceRepository.getSettings(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE_SETTINGS, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_UPDATE_SETTINGS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const settings = requirePlainObject(args, 'settings', ch)
    // Merge with existing settings to avoid overwriting fields set by other services
    // (e.g., githubTokenEncrypted set by github.service)
    const existing = workspaceRepository.getSettings(workspaceId)
    const merged = { ...existing, ...settings }
    const result = workspaceRepository.updateSettings(workspaceId, merged)

    // Update file watcher based on new settings
    try {
      const ws = workspaceRepository.findById(workspaceId)
      if (ws) {
        const s = merged as Record<string, unknown>
        if (s.repomapEnabled || s.semanticSearchEnabled) {
          fileWatcherService.start(workspaceId, ws.repoPath, {
            codeGraphEnabled: !!s.repomapEnabled,
            semanticSearchEnabled: !!s.semanticSearchEnabled
          })
        } else {
          fileWatcherService.stop(workspaceId)
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
        const ws = workspaceRepository.findById(workspaceId)
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
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE_AUTH, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_UPDATE_AUTH
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const authMode = requireString(args, 'authMode', ch)
    const anthropicApiKey = optionalString(args, 'anthropicApiKey', ch)

    if (authMode !== 'claude-max' && authMode !== 'api-key') {
      throw new Error(`${ch}: authMode must be 'claude-max' or 'api-key'`)
    }

    // Merge auth settings with existing workspace settings
    const existing = workspaceRepository.getSettings(workspaceId)
    const merged = {
      ...existing,
      authMode,
      // Only store API key if auth mode is api-key, otherwise clear it
      anthropicApiKey: authMode === 'api-key' ? anthropicApiKey : undefined
    }
    workspaceRepository.updateSettings(workspaceId, merged)

    // Reload auth provider for the active workspace
    const workspace = workspaceRepository.findAll().find((w) => w.id === workspaceId)
    if (workspace) {
      const { authProvider } = await import('../services/auth-provider')
      authProvider.loadFromWorkspace(workspace.repoPath)
    }

    return { success: true }
  })

  // ── External MCP prerequisite check ──
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CHECK_EXTERNAL_MCP, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_CHECK_EXTERNAL_MCP
    const args = requireObject(rawArgs, ch)
    const command = requireString(args, 'command', ch)
    // Sanitize: only allow simple command names (no slashes, spaces, or shell metacharacters)
    if (!/^[a-zA-Z0-9_-]+$/.test(command)) {
      throw new Error(`${ch}: invalid command name`)
    }
    try {
      const result = execSync(`which ${command}`, { stdio: 'pipe', timeout: 3000 })
      return { available: true, path: result.toString().trim() }
    } catch {
      return { available: false }
    }
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
