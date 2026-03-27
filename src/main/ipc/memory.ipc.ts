import type { BrowserWindow } from 'electron'
import { ipcMain, dialog } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import type { MemoryType } from '../../shared/types'
import { memoryService } from '../services/memory.service'
import { memoryFeedService } from '../services/memory-feed.service'
import { workspaceRepository } from '../db/repositories'
import { validateSender } from './validate-sender'
export function registerMemoryIpc(mainWindow: BrowserWindow): void {
  // ── Memory CRUD ──

  ipcMain.handle(IPC_CHANNELS.MEMORY_LIST, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return memoryService.list(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH,
    (event, args: { workspaceId: string; query: string }) => {
      validateSender(event)
      if (!args.query || args.query.trim().length === 0) {
        return memoryService.list(args.workspaceId)
      }
      return memoryService.search(args.workspaceId, args.query.trim())
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_CREATE,
    (
      event,
      args: {
        workspaceId: string | null
        type: MemoryType
        title: string
        content: string
        tags?: string[]
        importance?: number
      }
    ) => {
      validateSender(event)
      if (!args.title || !args.content) {
        throw new Error('Memory title and content are required')
      }
      return memoryService.create({
        workspaceId: args.workspaceId,
        type: args.type,
        title: args.title,
        content: args.content,
        tags: args.tags,
        importance: args.importance
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_UPDATE,
    (
      event,
      args: {
        id: string
        title?: string
        content?: string
        tags?: string[]
        importance?: number
      }
    ) => {
      validateSender(event)
      if (!args.id) throw new Error('Memory id is required')
      return memoryService.update(args.id, {
        title: args.title,
        content: args.content,
        tags: args.tags,
        importance: args.importance
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE, (event, args: { id: string }) => {
    validateSender(event)
    if (!args.id) throw new Error('Memory id is required')
    memoryService.delete(args.id)
  })

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_UPDATE_SETTING,
    (event, args: { workspaceId: string; memoryEnabled: boolean }) => {
      validateSender(event)
      const workspace = workspaceRepository.findById(args.workspaceId)
      if (!workspace) throw new Error(`Workspace not found: ${args.workspaceId}`)

      const settings = JSON.parse(workspace.settingsJson || '{}')
      settings.memoryEnabled = args.memoryEnabled
      workspaceRepository.updateSettings(args.workspaceId, settings)
    }
  )

  // ── Memory Feed ──

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEED_CLAUDE_MD,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      return memoryFeedService.feedFromClaudeMd(args.workspacePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.MEMORY_FEED_PROGRESS, progress)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEED_CODEBASE,
    async (event, args: { workspacePath: string }) => {
      validateSender(event)
      return memoryFeedService.feedFromCodebase(args.workspacePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.MEMORY_FEED_PROGRESS, progress)
      })
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEED_DOCUMENT,
    async (event, args: { workspacePath: string; filePath: string }) => {
      validateSender(event)
      if (!args.filePath) throw new Error('File path is required')
      return memoryFeedService.feedFromDocument(args.workspacePath, args.filePath, (progress) => {
        mainWindow.webContents.send(IPC_CHANNELS.MEMORY_FEED_PROGRESS, progress)
      })
    }
  )

  ipcMain.handle(IPC_CHANNELS.MEMORY_FEED_CANCEL, (event) => {
    validateSender(event)
    memoryFeedService.shutdown()
  })

  ipcMain.handle(IPC_CHANNELS.MEMORY_SELECT_DOCUMENT, async (event) => {
    validateSender(event)
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a document to feed into memory',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['md', 'txt', 'json', 'yaml', 'yml', 'toml'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
}
