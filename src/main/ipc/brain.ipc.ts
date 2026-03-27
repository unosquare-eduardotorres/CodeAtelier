import type { BrowserWindow } from 'electron'
import { ipcMain, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { IPC_CHANNELS } from '../../shared/constants'
import type { BrainEntry, BrainStatus } from '../../shared/types'
import { brainService } from '../services/brain.service'
import { brainFeedService } from '../services/brain-feed.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'

/** Known brain file names — must match brain.service.ts */
const ALLOWED_BRAIN_FILES = [
  'project-state.md',
  'changelog.md',
  'decisions-log.md',
  'errors-resolutions.md'
]

export function registerBrainIpc(mainWindow: BrowserWindow): void {
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
  ipcMain.handle(IPC_CHANNELS.BRAIN_COMPACT_ALL, async (event, args: { workspacePath: string }) => {
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
  })

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

  // Cancel in-progress brain feed
  ipcMain.handle(IPC_CHANNELS.BRAIN_FEED_CANCEL, (event) => {
    validateSender(event)
    brainFeedService.shutdown()
  })

  // ── Brain Feed handlers ──

  // File picker for document ingestion
  ipcMain.handle(IPC_CHANNELS.BRAIN_SELECT_DOCUMENT, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select Document to Ingest',
      filters: [
        {
          name: 'Supported Documents',
          extensions: ['md', 'txt', 'docx', 'xlsx', 'pdf', 'pptx', 'odt', 'ods', 'rtf']
        }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Feed from CLAUDE.md
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_FEED_CLAUDE_MD,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }

      return brainFeedService.feedFromClaudeMd(args.workspacePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.BRAIN_FEED_PROGRESS, progress)
      })
    }
  )

  // Feed from codebase scan
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_FEED_CODEBASE,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }

      return brainFeedService.feedFromCodebase(args.workspacePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.BRAIN_FEED_PROGRESS, progress)
      })
    }
  )

  // Feed from uploaded document
  ipcMain.handle(
    IPC_CHANNELS.BRAIN_FEED_DOCUMENT,
    async (event, args: { workspacePath: string; filePath: string }) => {
      validateSender(event)
      if (!args?.workspacePath || typeof args.workspacePath !== 'string') {
        throw new Error('Invalid workspace path')
      }
      if (!args?.filePath || typeof args.filePath !== 'string') {
        throw new Error('Invalid file path')
      }

      // Validate file path — must be absolute and not contain traversal
      const resolvedPath = resolve(args.filePath)
      if (!isAbsolute(args.filePath) || resolvedPath !== resolve(args.filePath)) {
        throw new Error('Invalid file path')
      }

      return brainFeedService.feedFromDocument(args.workspacePath, args.filePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.BRAIN_FEED_PROGRESS, progress)
      })
    }
  )
}
