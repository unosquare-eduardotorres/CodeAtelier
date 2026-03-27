import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { autoUpdateService } from '../services/auto-update.service'
import { validateSender } from './validate-sender'

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, (event) => {
    validateSender(event)
    autoUpdateService.checkForUpdates()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, (event) => {
    validateSender(event)
    autoUpdateService.downloadUpdate()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, (event) => {
    validateSender(event)
    autoUpdateService.installUpdate()
  })
}
