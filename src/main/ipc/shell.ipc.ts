import { ipcMain, shell } from 'electron'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import log from 'electron-log/main'

export function registerShellIpc(): void {
  ipcMain.handle(IPC_CHANNELS.SHELL_SHOW_ITEM_IN_FOLDER, (event, filePath: string) => {
    validateSender(event)
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('filePath must be a non-empty string')
    }
    // IPC-05: Reject protocol schemes (file://, http://) and relative `~` paths;
    // only allow absolute POSIX (/...) or Windows (C:\...) paths.
    if (!/^\//.test(filePath) && !/^[A-Z]:\\/.test(filePath)) {
      throw new Error('Invalid file path — must be an absolute path (no ~ or protocol schemes)')
    }
    // IPC-06: Wrap in try-catch to prevent unhandled exceptions
    try {
      shell.showItemInFolder(filePath)
    } catch (err) {
      log.scope('shell-ipc').error('showItemInFolder failed:', err)
      throw new Error('Failed to reveal item in folder')
    }
  })
}
