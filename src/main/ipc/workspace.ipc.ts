import { ipcMain, dialog, safeStorage } from 'electron'
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
import { encryptSettingsKeys } from './encrypt-settings-keys'
import { specialistBuilderService } from '../services/specialist-builder.service'

// ── Extracted handler functions ───────────────────────────────────────────

async function handleWorkspaceCreate(
  name: string,
  repoPath: string
): Promise<ReturnType<typeof workspaceRepository.create>> {
  const ch = IPC_CHANNELS.WORKSPACE_CREATE

  if (name.length > 255) {
    throw new Error(`${ch}: workspace name too long (max 255 chars)`)
  }

  const normalizedPath = resolve(repoPath)

  if (!existsSync(normalizedPath)) {
    throw new Error(`${ch}: the specified directory does not exist`)
  }

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

      // Auto-trigger specialist generation in the background.
      // The agent works immediately with DEFAULT_ARCHITECT_PROMPT,
      // then seamlessly upgrades when generation completes.
      specialistBuilderService.buildProjectSpecialist(workspace.id).catch((err) => {
        dbLogger.warn('Auto-build specialist failed (non-fatal):', err)
      })
    }
  } catch (err) {
    dbLogger.warn('Failed to seed Project Specialist on workspace create:', err)
  }

  return workspace
}

async function handleWorkspaceOpen(
  id: string
): Promise<ReturnType<typeof workspaceRepository.updateLastOpened>> {
  const workspace = workspaceRepository.updateLastOpened(id)
  if (!workspace) {
    throw new Error(`Workspace not found: ${id}`)
  }

  try {
    await repoService.ensureOwnRepo(workspace.repoPath)
  } catch (e) {
    dbLogger.warn('ensureOwnRepo on workspace open failed (non-fatal):', e)
  }

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

  try {
    const { authProvider } = await import('../services/auth-provider')
    authProvider.loadFromWorkspace(workspace.repoPath)
  } catch (e) {
    dbLogger.warn('Failed to load auth settings:', e)
  }

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
}

async function handleSettingsUpdate(
  workspaceId: string,
  settings: Record<string, unknown>
): Promise<ReturnType<typeof workspaceRepository.updateSettings>> {
  const existing = workspaceRepository.getSettings(workspaceId)
  const encrypted = encryptSettingsKeys({ ...existing, ...settings })
  const merged = encrypted
  const result = workspaceRepository.updateSettings(workspaceId, merged)

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
}

// ── IPC registration ─────────────────────────────────────────────────────

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
    return handleWorkspaceCreate(name, repoPath)
  })

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN, async (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.WORKSPACE_OPEN
    const args = requireObject(rawArgs, ch)
    const id = requireString(args, 'id', ch)
    return handleWorkspaceOpen(id)
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
    return handleSettingsUpdate(workspaceId, settings)
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

    // IPC-04: Wrap core logic in try-catch to prevent internal details from leaking
    try {
      // Merge auth settings with existing workspace settings
      const existing = workspaceRepository.getSettings(workspaceId)
      const merged: Record<string, unknown> = {
        ...existing,
        authMode
      }

      // IPC-01: Encrypt API key with safeStorage (OS keychain) before DB storage
      // — matches the pattern established in github.service.ts:69
      if (authMode === 'api-key' && anthropicApiKey) {
        const encrypted = safeStorage.encryptString(anthropicApiKey)
        merged.anthropicApiKey = encrypted.toString('base64')
        merged.anthropicApiKeyEncrypted = true
      } else {
        merged.anthropicApiKey = undefined
        merged.anthropicApiKeyEncrypted = false
      }
      workspaceRepository.updateSettings(workspaceId, merged)

      // Reload auth provider for the active workspace
      const workspace = workspaceRepository.findAll().find((w) => w.id === workspaceId)
      if (workspace) {
        const { authProvider } = await import('../services/auth-provider')
        authProvider.loadFromWorkspace(workspace.repoPath)
      }

      return { success: true }
    } catch (err) {
      dbLogger.error('WORKSPACE_UPDATE_AUTH failed:', err)
      throw new Error('Failed to update authentication settings')
    }
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
      execSync(`which ${command}`, { stdio: 'pipe', timeout: 3000 })
      // IPC-03: Don't expose filesystem path to renderer
      return { available: true }
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
