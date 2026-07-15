import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import { appPreferenceRepository } from '../db/repositories'
import type { UpdateConfig, UpdateSourceProvider } from '../../shared/types'

const updateLogger = log.scope('AutoUpdate')

/** Default config — matches current electron-builder.yml publish section */
const DEFAULT_CONFIG: UpdateConfig = {
  source: 'drive',
  drivePath: '',
  githubOwner: '',
  githubRepo: ''
}

class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null
  private config: UpdateConfig = { ...DEFAULT_CONFIG }

  init(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    // Use electron-log for updater logs
    autoUpdater.logger = updateLogger

    // Don't auto-download — let user decide
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true

    // Load persisted config and apply feed URL
    this.loadConfig()
    this.applyFeedUrl()

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
      const msg = String(err?.message ?? err)
      // Suppress noisy 404 dumps — expected when publish repo is private/not configured
      if (msg.includes('404') || msg.includes('HttpError')) {
        updateLogger.info('Update check skipped — release feed not reachable')
        return
      }
      updateLogger.error('Auto-update error:', err)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_ERROR, err.message)
    })
  }

  /** Read update config from app_preferences */
  private loadConfig(): void {
    const repo = appPreferenceRepository
    this.config = {
      source: (repo.get('update_source') as UpdateSourceProvider) ?? DEFAULT_CONFIG.source,
      drivePath: repo.get('update_drive_path') ?? DEFAULT_CONFIG.drivePath,
      githubOwner: repo.get('update_github_owner') ?? DEFAULT_CONFIG.githubOwner,
      githubRepo: repo.get('update_github_repo') ?? DEFAULT_CONFIG.githubRepo
    }
  }

  /** Apply the current config as the electron-updater feed URL */
  private applyFeedUrl(): void {
    if (this.config.source === 'drive' && this.config.drivePath) {
      // GenericServerOptions with file:// URL pointing to cloud drive folder
      // Folder must contain latest-mac.yml (macOS) / latest.yml (Windows) + .zip
      const fileUrl = `file://${this.config.drivePath}`
      updateLogger.info(`Setting update feed to Drive path: ${fileUrl}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoUpdater.setFeedURL({ provider: 'generic', url: fileUrl } as any)
    } else if (
      this.config.source === 'github' &&
      this.config.githubOwner &&
      this.config.githubRepo
    ) {
      // GitHub provider
      updateLogger.info(
        `Setting update feed to GitHub: ${this.config.githubOwner}/${this.config.githubRepo}`
      )
      const githubConfig = {
        provider: 'github' as const,
        owner: this.config.githubOwner,
        repo: this.config.githubRepo,
        private: true
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoUpdater.setFeedURL(githubConfig as any)
    } else {
      updateLogger.info('Update feed not configured — no source path set')
    }
  }

  /** Get current config (for IPC) */
  getConfig(): UpdateConfig {
    return { ...this.config }
  }

  /** Persist and apply new config */
  setConfig(config: Partial<UpdateConfig>): UpdateConfig {
    const repo = appPreferenceRepository
    if (config.source !== undefined) {
      this.config.source = config.source
      repo.set('update_source', config.source)
    }
    if (config.drivePath !== undefined) {
      this.config.drivePath = config.drivePath
      repo.set('update_drive_path', config.drivePath)
    }
    if (config.githubOwner !== undefined) {
      this.config.githubOwner = config.githubOwner
      repo.set('update_github_owner', config.githubOwner)
    }
    if (config.githubRepo !== undefined) {
      this.config.githubRepo = config.githubRepo
      repo.set('update_github_repo', config.githubRepo)
    }
    this.applyFeedUrl()
    return { ...this.config }
  }

  checkForUpdates(): void {
    updateLogger.info('Checking for updates...')
    autoUpdater.checkForUpdates().catch((err) => {
      // Silently ignore 404s — expected when publish repo is private or not configured
      const msg = String(err?.message ?? err)
      if (msg.includes('404') || msg.includes('HttpError')) {
        updateLogger.info('Update check skipped — release feed not reachable')
      } else {
        updateLogger.warn('Update check failed:', msg)
      }
    })
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
