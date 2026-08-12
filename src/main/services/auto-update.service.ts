import { autoUpdater } from 'electron-updater'
import { app, powerMonitor, autoUpdater as squirrelUpdater, type BrowserWindow } from 'electron'
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

/** How often the background poll asks the feed whether a newer build exists. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000
/**
 * Floor between two checks whatever triggered them. A machine waking from sleep
 * fires 'resume' right after an interval tick would have run — without this the
 * feed gets hit twice within a second.
 */
const MIN_CHECK_GAP_MS = 15 * 60 * 1000
/**
 * How long to wait for Squirrel to stage a macOS update before offering the
 * install anyway. Observed staging takes 17-28s; this is headroom, not a target.
 * The fallback is degraded (quitAndInstall may no-op) but never leaves the modal
 * stuck on Preparing with no way out.
 */
const STAGING_TIMEOUT_MS = 120_000
/**
 * How long doInstall() gets to end this process before we assume the install
 * never started. A successful install kills us long before this fires — the
 * quit path itself is bounded by the 5s failsafe in index.ts.
 */
const INSTALL_WATCHDOG_MS = 10_000

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
  /** Background poll handle. Non-null means polling is active. */
  private checkTimer: ReturnType<typeof setInterval> | null = null
  /** When the last check (of any origin) started, for the MIN_CHECK_GAP_MS floor. */
  private lastCheckAt = 0
  /** An artifact is on disk and not yet installed — further checks are pointless. */
  private updateDownloaded = false
  /** Kept so dispose() can detach it — powerMonitor outlives this service. */
  private onResume: (() => void) | null = null
  /**
   * macOS only: native Squirrel has fetched + staged the zip, so quitAndInstall()
   * will actually act. MacUpdater fires 'update-downloaded' when its proxy server
   * binds — 17-28s BEFORE this — and quitAndInstall() is a silent no-op until then.
   */
  private squirrelStaged = false
  /**
   * An install is committed. Guards the duplicate quitAndInstall() calls that
   * spawned competing ShipIt processes and produced the App Still Running Error.
   */
  private installRequested = false
  /** UPDATE_DOWNLOADED has reached the renderer — it must be sent at most once. */
  private readyAnnounced = false
  /** Version from the last 'update-downloaded', for the deferred announcement. */
  private downloadedVersion: string | null = null
  /** Staging watchdog handle, non-null while waiting on Squirrel. */
  private stagingTimer: ReturnType<typeof setTimeout> | null = null
  /** Install watchdog handle, non-null between a dispatched install and its deadline. */
  private installTimer: ReturnType<typeof setTimeout> | null = null

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
      this.updateDownloaded = true
      this.downloadedVersion = String(info.version)
      updateLogger.info('Update downloaded:', info.version)

      if (process.platform !== 'darwin') {
        this.readyAnnounced = true
        this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED, {
          version: info.version
        })
        return
      }

      // MacUpdater emits this the moment its proxy server binds, before Squirrel
      // has fetched anything. Announcing readiness here is what let the user press
      // Restart into a dead window where quitAndInstall() does nothing at all.
      updateLogger.info('Waiting for Squirrel to stage the update...')
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_STAGING, {
        version: info.version
      })
      this.armStagingTimeout()
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

    if (process.platform === 'darwin') {
      // The native updater's own event is the only honest signal that the update
      // is installable. electron.autoUpdater throws on Linux, hence the guard.
      squirrelUpdater.on('update-downloaded', () => {
        updateLogger.info('Squirrel finished staging the update')
        this.announceReady()
      })
      squirrelUpdater.on('error', (err) => {
        updateLogger.warn('Native Squirrel staging failed:', err)
        // Re-arm first so announceReady() does not dispatch an install into a
        // staging attempt that just failed — the user gets the button back instead.
        this.installRequested = false
        this.announceReady()
      })
    }
  }

  /** Never leave the modal on Preparing forever if Squirrel goes quiet. */
  private armStagingTimeout(): void {
    this.clearStagingTimer()
    this.stagingTimer = setTimeout(() => {
      this.stagingTimer = null
      updateLogger.warn(
        `Squirrel did not finish staging within ${STAGING_TIMEOUT_MS / 1000}s — offering the install anyway`
      )
      this.announceReady()
    }, STAGING_TIMEOUT_MS)
    this.stagingTimer.unref?.()
  }

  private clearStagingTimer(): void {
    if (this.stagingTimer) {
      clearTimeout(this.stagingTimer)
      this.stagingTimer = null
    }
  }

  /**
   * The update is installable — Squirrel finished staging, or staging failed and
   * firing quitAndInstall() blind is the best option left. Idempotent: the
   * renderer hears UPDATE_DOWNLOADED once, and a deferred install runs once.
   */
  private announceReady(): void {
    this.clearStagingTimer()
    this.squirrelStaged = true
    if (this.updateDownloaded && !this.readyAnnounced) {
      this.readyAnnounced = true
      updateLogger.info('Update ready to install:', this.downloadedVersion)
      this.mainWindow?.webContents.send(IPC_CHANNELS.UPDATE_DOWNLOADED, {
        version: this.downloadedVersion ?? ''
      })
    }
    // A click that landed during staging was deferred, not dropped.
    if (this.installRequested) this.doInstall()
  }

  /** Whether quitAndInstall() would do anything right now. */
  private isStaged(): boolean {
    // Windows/Linux have no staging step — the artifact is on disk already.
    return process.platform !== 'darwin' || this.squirrelStaged
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
    /* eslint-disable @typescript-eslint/no-require-imports -- deferred: only needed on this rare path */
    const { platform, homedir } = require('node:os')
    const { readdirSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    /* eslint-enable @typescript-eslint/no-require-imports */
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

  /**
   * Begin polling the feed in the background. Idempotent — a second call is a
   * no-op, so it is safe to call from both startup and a config change.
   *
   * Without this the app only ever checked once, 5s after launch: a session left
   * open for hours never noticed a release published in the meantime.
   */
  startPeriodicChecks(): void {
    if (this.checkTimer) return
    this.checkTimer = setInterval(() => this.maybeCheck(), CHECK_INTERVAL_MS)
    this.checkTimer.unref?.()
    // A laptop asleep overnight misses every interval tick, so it would come back
    // to a stale version and wait a full hour before noticing.
    this.onResume = () => this.maybeCheck()
    powerMonitor.on('resume', this.onResume)
    updateLogger.info(`Background update checks started (every ${CHECK_INTERVAL_MS / 60000}m)`)
  }

  /** A background check, skipped whenever it would be pointless or redundant. */
  private maybeCheck(): void {
    if (this.downloadInFlight || this.updateDownloaded) return
    if (Date.now() - this.lastCheckAt < MIN_CHECK_GAP_MS) return
    this.checkForUpdates(false)
  }

  private stopPeriodicChecks(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer)
      this.checkTimer = null
    }
    if (this.onResume) {
      powerMonitor.removeListener('resume', this.onResume)
      this.onResume = null
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

  /** Stop background polling and close the loopback feed server (called on app quit) */
  async dispose(): Promise<void> {
    this.stopPeriodicChecks()
    this.clearStagingTimer()
    this.clearInstallTimer()
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
    this.lastCheckAt = Date.now()
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

  /**
   * Install now and come back on the new version. `(isSilent, isForceRunAfter)`:
   * silent skips the Windows NSIS installer UI (the build is oneClick, so there
   * is nothing to configure), force-run-after relaunches us afterwards. MacUpdater
   * takes no arguments at all — there the call only arms Squirrel's relaunch, and
   * doInstall() has to end the process itself.
   *
   * On macOS before Squirrel has staged, quitAndInstall() is a documented no-op,
   * so the request is remembered and dispatched by announceReady() instead.
   */
  installUpdate(): void {
    if (this.installRequested) {
      updateLogger.info('Install already requested — ignoring duplicate')
      return
    }
    this.installRequested = true
    if (!this.isStaged()) {
      updateLogger.info('Install deferred — waiting for Squirrel to finish staging')
      return
    }
    this.doInstall()
  }

  private doInstall(): void {
    updateLogger.info('Installing update and restarting...')
    this.armInstallWatchdog()
    autoUpdater.quitAndInstall(true, true)

    // Windows/Linux: BaseUpdater spawned the installer and quits by itself.
    // Quitting again here would race that spawn.
    if (process.platform !== 'darwin') return

    // macOS: quitAndInstall() routes to MacUpdater.handleUpdateDownloaded(), which
    // closes the proxy server and delegates to the native updater — then returns,
    // leaving us running. (Observed: the click logged 'Closing proxy server' 15ms
    // later and nothing else — no before-quit markers at all.) ShipIt is already
    // armed and watching this PID, so ending the process is what applies the swap.
    // app.quit() and not app.exit(0): before-quit is where sessions are stopped and
    // the DB WAL is checkpointed, and it ends in app.exit(0) anyway.
    app.quit()
  }

  /**
   * installRequested is a latch with no owner but process death. A click that
   * failed to terminate us left it set for the rest of the session, so every
   * later press of Restart bounced off it silently. Release it if we survive.
   */
  private armInstallWatchdog(): void {
    this.clearInstallTimer()
    this.installTimer = setTimeout(() => this.onInstallStalled(), INSTALL_WATCHDOG_MS)
    this.installTimer.unref?.()
  }

  private clearInstallTimer(): void {
    if (this.installTimer) {
      clearTimeout(this.installTimer)
      this.installTimer = null
    }
  }

  private onInstallStalled(): void {
    this.installTimer = null
    updateLogger.error(
      `Install did not start within ${INSTALL_WATCHDOG_MS / 1000}s — the app is still running`
    )
    this.installRequested = false
    // Not UPDATE_ERROR: that flips the modal to 'error' and removes the very button
    // the user needs. This failure is retryable, and quitting installs it regardless.
    const version = this.downloadedVersion ? ` v${this.downloadedVersion}` : ''
    this.mainWindow?.webContents.send(
      IPC_CHANNELS.UPDATE_INSTALL_FAILED,
      `The update could not start. Quit and reopen Code Atelier to finish installing${version}.`
    )
  }

  /**
   * Install a downloaded update as part of quitting — Windows/Linux only.
   *
   * There, autoInstallOnAppQuit hangs off the 'quit' event and our before-quit
   * handler ends in app.exit(0), which never emits it — so "it installs when you
   * close the app" silently never happened. Do it explicitly.
   */
  installOnQuitIfReady(): void {
    if (!this.updateDownloaded) return
    // macOS needs nothing here: autoInstallOnAppQuit already had MacUpdater stage
    // the update with Squirrel, and ShipIt applies it when the process dies —
    // app.exit(0) at index.ts:1000 satisfies that. Calling quitAndInstall() would
    // instead route to handleUpdateDownloaded(), close the proxy server and arm
    // autoRunAppAfterInstall — reopening the app the user just quit.
    if (process.platform === 'darwin') return
    updateLogger.info('Installing downloaded update on quit')
    try {
      // No relaunch: the user asked to quit, not to restart.
      autoUpdater.quitAndInstall(true, false)
    } catch (err) {
      updateLogger.warn('Install-on-quit failed (non-fatal):', err)
    }
  }
}

export const autoUpdateService = new AutoUpdateService()
