import { autoUpdater } from 'electron-updater'
import { app, type BrowserWindow } from 'electron'
import log from 'electron-log/main'
import { existsSync } from 'node:fs'
import { IPC_CHANNELS } from '../../shared/constants'
import { appPreferenceRepository } from '../db/repositories'
import { startUpdateFeedServer, type FeedServerHandle } from './update-feed-server'
import {
  describeUpdateError,
  isFeedUnreachable,
  isStaleFeed,
  shouldReportError
} from './auto-update-helpers'
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
  private feedServer: FeedServerHandle | null = null
  /** Resolves once the in-flight applyFeedUrl() has finished. */
  private feedReady: Promise<void> = Promise.resolve()
  /**
   * Whether the outcome of the check currently in flight must reach the user.
   * Cleared by whichever outcome event fires first, so a result is reported once.
   */
  private userInitiatedCheck = false
  /**
   * A download is in flight. Downloads are always user-initiated, so their
   * failures are always reported — including the 404 that a manifest pointing at
   * a missing artifact produces, which the check itself cannot detect.
   */
  private downloadInFlight = false
  /** Why the feed is unusable, or null when it is usable. Set by applyFeedUrlAsync(). */
  private feedUnavailableReason: string | null = 'No update source configured'
  /** Where we are looking for updates — included in user-facing error messages. */
  private feedDescription = ''

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
      this.userInitiatedCheck = false
      updateLogger.info('Update available:', info.version)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_AVAILABLE, {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    })

    autoUpdater.on('update-not-available', (info) => {
      this.userInitiatedCheck = false
      const currentVersion = app.getVersion()
      updateLogger.info(
        `No update available. Current version: ${currentVersion}, feed offers: ${info.version}`
      )
      if (isStaleFeed(String(info.version), currentVersion)) {
        // The feed advertising something older than what is installed means the
        // published manifest is stale or was overwritten by another platform's
        // build — not "you are up to date".
        updateLogger.warn(
          `Update feed is stale — it advertises v${info.version} but v${currentVersion} is installed (${this.feedDescription || 'unknown source'})`
        )
      }
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_NOT_AVAILABLE, { currentVersion })
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
      this.downloadInFlight = false
      updateLogger.info('Update downloaded:', info.version)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED, {
        version: info.version
      })
    })

    autoUpdater.on('error', (err) => {
      const msg = String(err?.message ?? err)
      const userInitiated = this.userInitiatedCheck || this.downloadInFlight
      this.userInitiatedCheck = false
      this.downloadInFlight = false
      // A 404 on an automatic check is expected when no feed is published yet —
      // but a check or download the user asked for must never fail silently.
      if (!shouldReportError(msg, userInitiated)) {
        updateLogger.info('Update check skipped — release feed not reachable')
        return
      }
      updateLogger.error('Auto-update error:', err)
      this.mainWindow?.webContents.send(
        IPC_CHANNELS.UPDATE_ERROR,
        describeUpdateError(msg, this.feedDescription)
      )
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
    // Auto-detect OneDrive path on first run if no drivePath is configured
    if (this.config.source === 'drive' && !this.config.drivePath) {
      const detected = this.detectOneDrivePath()
      if (detected) {
        updateLogger.info(`Auto-detected OneDrive update path: ${detected}`)
        this.config.drivePath = detected
        repo.set('update_drive_path', detected)
      }
    }
  }

  /**
   * Auto-detect the OneDrive "Code Atelier" folder for update distribution.
   * Returns the local sync path or null if not found.
   */
  private detectOneDrivePath(): string | null {
    const { platform, homedir } = require('node:os')
    const { readdirSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const home = homedir()
    const targetFolder = 'Code Atelier'

    try {
      if (platform() === 'darwin') {
        // macOS: ~/Library/CloudStorage/OneDrive-*/Code Atelier
        const cloudStorage = join(home, 'Library', 'CloudStorage')
        if (existsSync(cloudStorage)) {
          const entries = readdirSync(cloudStorage)
          for (const entry of entries) {
            if (entry.startsWith('OneDrive')) {
              const candidate = join(cloudStorage, entry, targetFolder)
              if (existsSync(candidate)) return candidate
            }
          }
        }
      } else if (platform() === 'win32') {
        // Windows: %USERPROFILE%\OneDrive - *\Code Atelier
        const entries = readdirSync(home)
        for (const entry of entries) {
          if (entry.startsWith('OneDrive')) {
            const candidate = join(home, entry, targetFolder)
            if (existsSync(candidate)) return candidate
          }
        }
      }
    } catch {
      // Non-fatal — user can configure manually
    }
    return null
  }

  /** Apply the current config as the electron-updater feed URL */
  private applyFeedUrl(): void {
    this.feedReady = this.applyFeedUrlAsync().catch((err) => {
      updateLogger.error('Failed to apply update feed:', err)
    })
  }

  private async applyFeedUrlAsync(): Promise<void> {
    await this.stopFeedServer()
    // Pessimistic until a branch below proves the feed usable — a check that
    // races a failed re-configure must report, not fall through to a 404.
    this.feedUnavailableReason = 'Update feed is not ready'
    this.feedDescription = ''

    if (this.config.source === 'drive' && this.config.drivePath) {
      this.feedDescription = this.config.drivePath
      if (!existsSync(this.config.drivePath)) {
        updateLogger.warn(`Update drive path does not exist: ${this.config.drivePath}`)
        this.feedUnavailableReason = `Update source folder not found: ${this.config.drivePath}`
        return
      }
      // electron-updater's generic provider fetches through electron.net, which
      // only supports http:/https: — a file:// feed throws "ClientRequest only
      // supports http: and https: protocols" on every check. Serve the synced
      // folder over loopback HTTP instead.
      // Folder must contain latest-mac.yml (macOS) / latest.yml (Windows) + artifacts.
      this.feedServer = await startUpdateFeedServer(this.config.drivePath)
      this.feedUnavailableReason = null
      updateLogger.info(`Serving update feed from ${this.config.drivePath}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      autoUpdater.setFeedURL({ provider: 'generic', url: this.feedServer.url } as any)
      // publish-to-onedrive.sh does not copy .blockmap files, so a differential
      // download would 404 before falling back to the full artifact.
      autoUpdater.disableDifferentialDownload = true
    } else if (
      this.config.source === 'github' &&
      this.config.githubOwner &&
      this.config.githubRepo
    ) {
      // GitHub provider
      this.feedDescription = `github:${this.config.githubOwner}/${this.config.githubRepo}`
      this.feedUnavailableReason = null
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
      autoUpdater.disableDifferentialDownload = false
    } else {
      // Falling through to the packaged app-update.yml would point electron-updater
      // at the private GitHub publish repo, which can only ever 404. Refuse instead.
      this.feedDescription = ''
      this.feedUnavailableReason = 'No update source configured — set one in Settings › Updates'
      updateLogger.info('Update feed not configured — no source path set')
    }
  }

  private async stopFeedServer(): Promise<void> {
    if (!this.feedServer) return
    try {
      await this.feedServer.close()
    } catch (err) {
      updateLogger.debug('Update feed server close error (non-fatal):', err)
    }
    this.feedServer = null
  }

  /** Close the loopback feed server (called on app quit) */
  async dispose(): Promise<void> {
    await this.stopFeedServer()
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

  /**
   * @param userInitiated true when the user pressed "Check for Updates". Such a
   * check always reports its outcome; the automatic startup check stays quiet.
   */
  checkForUpdates(userInitiated = false): void {
    this.userInitiatedCheck = userInitiated
    updateLogger.info(
      `Checking for updates (${userInitiated ? 'user-initiated' : 'automatic'})... current version: ${app.getVersion()}`
    )
    // Wait for the loopback feed server to bind before asking electron-updater
    // to fetch — otherwise the first check races against setFeedURL().
    this.feedReady
      .then(() => {
        if (this.feedUnavailableReason) {
          this.reportCheckFailure(this.feedUnavailableReason, { alreadyReadable: true })
          return undefined
        }
        return autoUpdater.checkForUpdates()
      })
      .catch((err) => {
        this.reportCheckFailure(String(err?.message ?? err))
      })
  }

  /**
   * Report a failed check. The 'error' event handler clears userInitiatedCheck,
   * so a failure that surfaced there is only logged here, never sent twice.
   */
  private reportCheckFailure(message: string, opts?: { alreadyReadable?: boolean }): void {
    const userInitiated = this.userInitiatedCheck
    this.userInitiatedCheck = false

    if (!userInitiated) {
      if (isFeedUnreachable(message)) {
        updateLogger.info('Update check skipped — release feed not reachable')
      } else {
        updateLogger.warn('Update check failed:', message)
      }
      return
    }

    updateLogger.error('Update check failed:', message)
    this.mainWindow?.webContents.send(
      IPC_CHANNELS.UPDATE_ERROR,
      opts?.alreadyReadable ? message : describeUpdateError(message, this.feedDescription)
    )
  }

  downloadUpdate(): void {
    updateLogger.info('Downloading update...')
    this.downloadInFlight = true
    autoUpdater.downloadUpdate()
  }

  installUpdate(): void {
    updateLogger.info('Installing update and restarting...')
    autoUpdater.quitAndInstall()
  }
}

export const autoUpdateService = new AutoUpdateService()
