import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { autoUpdateService } from '../services/auto-update.service'
import { validateSender } from './validate-sender'
import type { UpdateConfig } from '../../shared/types'

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, (event) => {
    validateSender(event)
    // Reached only from the "Check for Updates" button — always report the outcome.
    autoUpdateService.checkForUpdates(true)
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, (event) => {
    validateSender(event)
    autoUpdateService.downloadUpdate()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, (event) => {
    validateSender(event)
    autoUpdateService.installUpdate()
  })

  // Update config management
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_CONFIG, (event) => {
    validateSender(event)
    return autoUpdateService.getConfig()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_SET_CONFIG, (event, config: Partial<UpdateConfig>) => {
    validateSender(event)
    return autoUpdateService.setConfig(config)
  })
}
