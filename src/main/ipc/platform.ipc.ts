import { app, ipcMain } from 'electron'
import os from 'node:os'
import { IPC_CHANNELS } from '../../shared/constants'
import { validateSender } from './validate-sender'
import type { PlatformInfo } from '../../shared/types'

export function registerPlatformIpc(): void {
  ipcMain.handle(IPC_CHANNELS.PLATFORM_INFO, (event): PlatformInfo => {
    validateSender(event)
    const totalMemoryGB = Math.round(os.totalmem() / 1024 ** 3)
    return {
      platform: process.platform as PlatformInfo['platform'],
      arch: process.arch,
      isAppleSilicon: process.platform === 'darwin' && process.arch === 'arm64',
      totalMemoryGB,
      appVersion: app.getVersion()
    }
  })
}
