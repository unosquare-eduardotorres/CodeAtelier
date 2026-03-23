import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { autoUpdateService } from '../services/auto-update.service'

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, () => {
    autoUpdateService.checkForUpdates()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, () => {
    autoUpdateService.downloadUpdate()
  })

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, () => {
    autoUpdateService.installUpdate()
  })
}
