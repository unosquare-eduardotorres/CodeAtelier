import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import log from '../logger'
import { IPC_CHANNELS } from '../../shared/constants'

const updateLogger = log.scope('AutoUpdate')

class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    // Use electron-log for updater logs
    autoUpdater.logger = updateLogger

    // Don't auto-download — let user decide
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // Events -> forward to renderer
    autoUpdater.on('update-available', (info) => {
      updateLogger.info('Update available:', info.version)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      updateLogger.info('No update available. Current version:', info.version)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_NOT_AVAILABLE)
    })

    autoUpdater.on('download-progress', (progress) => {
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_PROGRESS, {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    autoUpdater.on('update-downloaded', (info) => {
      updateLogger.info('Update downloaded:', info.version)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED, {
        version: info.version
      })
    })

    autoUpdater.on('error', (err) => {
      updateLogger.error('Auto-update error:', err)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_ERROR, err.message)
    })
  }

  checkForUpdates(): void {
    updateLogger.info('Checking for updates...')
    autoUpdater.checkForUpdates()
  }

  downloadUpdate(): void {
    updateLogger.info('Downloading update...')
    autoUpdater.downloadUpdate()
  }

  installUpdate(): void {
    updateLogger.info('Installing update and restarting...')
    autoUpdater.quitAndInstall()
  }
}

export const autoUpdateService = new AutoUpdateService()
