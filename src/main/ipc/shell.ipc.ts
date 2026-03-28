import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'

export function registerShellIpc(): void {
  ipcMain.handle(
    IPC_CHANNELS.SHELL_SHOW_ITEM_IN_FOLDER,
    (event, filePath: string) => {
      validateSender(event)
      if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('filePath must be a non-empty string')
      }
      // Security: only allow absolute paths, no protocol schemes
      if (!/^[\/~]/.test(filePath) && !/^[A-Z]:\\/.test(filePath)) {
        throw new Error('Invalid file path — must be absolute')
      }
      shell.showItemInFolder(filePath)
    }
  )
}
