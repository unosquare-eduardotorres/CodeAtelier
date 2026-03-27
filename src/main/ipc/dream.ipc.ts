import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { dreamRunRepository } from '../db/repositories'
import { dreamService } from '../services/dream.service'
import { validateSender } from './validate-sender'
import { dbLogger } from '../logger'
import type { DreamProgress } from '../../shared/types'

const log = dbLogger

export function registerDreamIpc(mainWindow: BrowserWindow): void {
  // Forward dream progress events to the renderer
  dreamService.on('progress', (progress: DreamProgress) => {
    mainWindow.webContents.send(IPC_CHANNELS.DREAM_PROGRESS, progress)
  })

  ipcMain.handle(IPC_CHANNELS.DREAM_TRIGGER, async (event, args: { workspaceId: string }) => {
    validateSender(event)
    log.info('Dream trigger requested for workspace:', args.workspaceId)

    // Run dream consolidation via the dream service
    const result = await dreamService.run(args.workspaceId, 'manual')
    return result
  })

  ipcMain.handle(IPC_CHANNELS.DREAM_CANCEL, (event, args: { workspaceId: string }) => {
    validateSender(event)
    dreamService.cancel(args.workspaceId)
    log.info('Dream cancelled for workspace:', args.workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.DREAM_GET_STATUS, (event, args: { workspaceId: string }) => {
    validateSender(event)
    return dreamRunRepository.findRunning(args.workspaceId)
  })

  ipcMain.handle(
    IPC_CHANNELS.DREAM_GET_HISTORY,
    (event, args: { workspaceId: string; limit?: number }) => {
      validateSender(event)
      return dreamRunRepository.findByWorkspace(args.workspaceId, args.limit ?? 20)
    }
  )
}
