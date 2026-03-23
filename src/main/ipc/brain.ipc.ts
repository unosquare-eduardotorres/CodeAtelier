import { ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import type { BrainEntry, BrainStatus } from '../../shared/types'
import { brainService } from '../services/brain.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

/** Known brain file names — must match brain.service.ts */
const ALLOWED_BRAIN_FILES = [
  'project-state.md',
  'changelog.md',
  'decisions-log.md',
  'errors-resolutions.md'
]

export function registerBrainIpc(): void {
  // Get full brain context for display or prompt injection
  ipcMain.handle(IPC_CHANNELS.BRAIN_GET_CONTEXT, async (event, args: { workspacePath: string }) => {
    validateSender(event)
    if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    return brainService.getContext(args.workspacePath)
  })

  // Get project state summary
  ipcMain.handle(IPC_CHANNELS.BRAIN_GET_STATE, async (event, args: { workspacePath: string }) => {
    validateSender(event)
    if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
      throw new Error('Invalid workspace path')
    }
    return brainService.getProjectState(args.workspacePath)
  })

  // Manually log a decision from the UI
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_LOG_DECISION,
    async (event, args: { workspacePath: string; entry: BrainEntry }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }
      if (!args.entry || typeof args.entry.summary !== 'string') {
        throw new Error('Invalid brain entry')
      }
      brainService.logDecision(args.workspacePath, args.entry)
    }
  )

  // Get detailed info about all brain files
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_GET_FILES_INFO,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }

      const files = brainService.getFilesInfo(args.workspacePath)
      const workspace = workspaceRepository.findAll().find((w) => w.repoPath === args.workspacePath)
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      return {
        enabled: settings.brainEnabled !== false, // default true
        initialized: existsSync(join(args.workspacePath, '.brain')),
        files,
        totalLines: files.reduce((s, f) => s + f.lineCount, 0),
        totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
        totalEstimatedTokens: files.reduce((s, f) => s + f.estimatedTokens, 0)
      } satisfies BrainStatus
    }
  )

  // Force-compact a specific brain file
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_COMPACT_FILE,
    async (event, args: { workspacePath: string; fileName: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }
      if (!ALLOWED_BRAIN_FILES.includes(args.fileName)) {
        throw new Error('Invalid brain file name')
      }
      return brainService.forceCompact(args.workspacePath, args.fileName)
    }
  )

  // Force-compact all brain files
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_COMPACT_ALL,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }

      const files = brainService.forceCompactAll(args.workspacePath)
      const workspace = workspaceRepository.findAll().find((w) => w.repoPath === args.workspacePath)
      const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

      return {
        enabled: settings.brainEnabled !== false,
        initialized: existsSync(join(args.workspacePath, '.brain')),
        files,
        totalLines: files.reduce((s, f) => s + f.lineCount, 0),
        totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
        totalEstimatedTokens: files.reduce((s, f) => s + f.estimatedTokens, 0)
      } satisfies BrainStatus
    }
  )

  // Update brain enabled/disabled setting for a workspace
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_UPDATE_SETTING,
    async (event, args: { workspaceId: string; brainEnabled: boolean }) => {
      validateSender(event)
      if (!args?.workspaceId || typeof args.workspaceId !== 'string') {
        throw new Error('Invalid workspace ID')
      }

      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error('Workspace not found')

      const settings = JSON.parse(workspace.settingsJson || '{}')
      settings.brainEnabled = args.brainEnabled
      workspaceRepository.updateSettings(args.workspaceId, settings)
    }
  )
}
