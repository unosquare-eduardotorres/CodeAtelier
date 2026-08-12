import { create } from 'zustand'
import type { UpdateConfig, UpdateSourceProvider } from '../../../shared/types'
import { useToastStore } from './toast.store'
import { nextSnooze, isSnoozed, LATER_MUTES, DISMISS_MUTES } from './update-store-utils'

type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  /** Downloaded, but the platform is still preparing it — not installable yet. */
  | 'staging'
  | 'ready'
  | 'error'

interface UpdateState {
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  downloadProgress: number
  /** Bytes/second reported by electron-updater, 0 before the first tick. */
  downloadSpeed: number
  downloadTransferred: number
  downloadTotal: number
  errorMessage: string | null

  // Modal visibility
  showModal: boolean

  /**
   * "Later" mutes the auto-popup for one version. Without this, hourly checks
   * would re-open the modal on every tick for an update the user declined.
   */
  snoozedVersion: string | null
  snoozeUntil: number

  /** The download was confirmed in the modal, so install without asking again. */
  autoInstall: boolean
  /** Seconds left before the automatic restart, or null when not counting down. */
  installCountdown: number | null

  // Update config
  config: UpdateConfig
  configLoaded: boolean

  // Actions
  checkForUpdates: () => void
  downloadUpdate: () => void
  installUpdate: () => void
  cancelAutoInstall: () => void
  dismiss: () => void

  // Config actions
  loadConfig: () => Promise<void>
  setSource: (source: UpdateSourceProvider) => Promise<void>
  setDrivePath: (path: string) => Promise<void>
  setGithubConfig: (owner: string, repo: string) => Promise<void>
  openModal: () => void
  closeModal: () => void

  // Internal setters (called from App.tsx listener wiring)
  setAvailable: (version: string, releaseNotes?: string, releaseDate?: string) => void
  setNotAvailable: (currentVersion?: string) => void
  setStaging: (version: string) => void
  setDownloaded: (version: string) => void
  setProgress: (
    percent: number,
    bytesPerSecond?: number,
    transferred?: number,
    total?: number
  ) => void
  setError: (message: string) => void
  setInstallFailed: (message: string) => void
}

const DEFAULT_CONFIG: UpdateConfig = {
  source: 'drive',
  drivePath: '',
  githubOwner: '',
  githubRepo: ''
}

/**
 * A check that never comes back must not leave the button stuck on "Checking...".
 * Cleared by whichever outcome setter fires first.
 */
const CHECK_TIMEOUT_MS = 30_000
let checkWatchdog: ReturnType<typeof setTimeout> | null = null

function clearWatchdog(): void {
  if (checkWatchdog !== null) {
    clearTimeout(checkWatchdog)
    checkWatchdog = null
  }
}

/** Seconds of grace before an auto-confirmed update restarts the app. */
const INSTALL_COUNTDOWN_SECONDS = 3

let installTimer: ReturnType<typeof setInterval> | null = null

function clearInstallTimer(): void {
  if (installTimer !== null) {
    clearInterval(installTimer)
    installTimer = null
  }
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  releaseDate: null,
  downloadProgress: 0,
  downloadSpeed: 0,
  downloadTransferred: 0,
  downloadTotal: 0,
  errorMessage: null,
  showModal: false,
  snoozedVersion: null,
  snoozeUntil: 0,
  autoInstall: false,
  installCountdown: null,
  config: { ...DEFAULT_CONFIG },
  configLoaded: false,

  checkForUpdates: () => {
    // A check the user asked for must be able to surface its result, so it
    // clears any snooze left over from a previous "Later".
    set({ status: 'checking', errorMessage: null, snoozedVersion: null, snoozeUntil: 0 })
    clearWatchdog()
    checkWatchdog = setTimeout(() => {
      checkWatchdog = null
      if (useUpdateStore.getState().status !== 'checking') return
      set({ status: 'idle' })
      useToastStore.getState().addToast({
        type: 'error',
        message: 'Update check timed out — the update source did not respond'
      })
    }, CHECK_TIMEOUT_MS)
    window.api.checkForUpdate()
  },

  downloadUpdate: () => {
    // Always show the modal: the download was confirmed here, so its progress
    // belongs here too — whichever button started it.
    set({
      status: 'downloading',
      downloadProgress: 0,
      downloadSpeed: 0,
      downloadTransferred: 0,
      downloadTotal: 0,
      showModal: true,
      autoInstall: true,
      // Downloading is re-engagement: a live snooze on this version would
      // otherwise hide the "ready to install" banner the download produces.
      snoozedVersion: null,
      snoozeUntil: 0
    })
    window.api.downloadUpdate()
  },

  installUpdate: () => {
    clearInstallTimer()
    window.api.installUpdate()
  },

  cancelAutoInstall: () => {
    clearInstallTimer()
    set({ installCountdown: null, autoInstall: false })
  },

  dismiss: () => {
    clearInstallTimer()
    // Snooze like "Later" does: without it the next hourly check calls
    // setAvailable() and re-opens the modal on an update just waved away.
    set((s) => ({
      // A downloaded update is not gone just because the banner was dismissed —
      // it still installs on quit and Settings must keep offering it. Only the
      // nag is silenced; the banner honours the snooze.
      status: s.status === 'ready' ? 'ready' : 'idle',
      showModal: false,
      installCountdown: null,
      autoInstall: false,
      ...nextSnooze(s, DISMISS_MUTES)
    }))
  },

  // Config actions
  loadConfig: async () => {
    try {
      const config = await window.api.getUpdateConfig()
      set({ config, configLoaded: true })
    } catch {
      // Silently ignore — defaults are safe
    }
  },

  setSource: async (source) => {
    const config = await window.api.setUpdateConfig({ source })
    set({ config })
  },

  setDrivePath: async (path) => {
    const config = await window.api.setUpdateConfig({ drivePath: path })
    set({ config })
  },

  setGithubConfig: async (owner, repo) => {
    const config = await window.api.setUpdateConfig({ githubOwner: owner, githubRepo: repo })
    set({ config })
  },

  openModal: () => set({ showModal: true }),

  closeModal: () => set((s) => ({ showModal: false, ...nextSnooze(s, LATER_MUTES) })),

  // Internal setters
  setAvailable: (version, releaseNotes, releaseDate) => {
    clearWatchdog()
    const { snoozedVersion, snoozeUntil } = useUpdateStore.getState()
    // Snoozed — the badge in Settings and the banner still show it; only the
    // interruption is suppressed.
    const snoozed = isSnoozed(version, snoozedVersion, snoozeUntil)
    set({
      status: 'available',
      availableVersion: version,
      releaseNotes: releaseNotes ?? null,
      releaseDate: releaseDate ?? null,
      showModal: !snoozed
    })
  },

  setNotAvailable: (currentVersion) => {
    clearWatchdog()
    // Closing the modal matters: setAvailable() is what opens it, so leaving it
    // open here rendered an empty body — the "Check for Updates does nothing"
    // symptom. The toast is the only confirmation the check actually ran.
    set({ status: 'idle', showModal: false })
    useToastStore.getState().addToast({
      type: 'success',
      message: currentVersion
        ? `You're on the latest version (v${currentVersion})`
        : "You're on the latest version"
    })
  },

  /**
   * The download finished but the update cannot be installed yet — macOS Squirrel
   * still has to stage it. No countdown and no restart button here: main only
   * sends UPDATE_DOWNLOADED once quitAndInstall() will actually do something.
   */
  setStaging: (version) => {
    clearWatchdog()
    clearInstallTimer()
    // showModal is left alone: the modal is already open from the download, and a
    // user who closed it should not have it reappear before there is a decision.
    set({
      status: 'staging',
      availableVersion: version,
      downloadProgress: 100,
      installCountdown: null
    })
  },

  setDownloaded: (version) => {
    clearWatchdog()
    set({ status: 'ready', availableVersion: version, downloadProgress: 100 })

    // The user already confirmed this update when they pressed "Update Now" —
    // asking a second time is the "why do I have an Install button?" complaint.
    if (!useUpdateStore.getState().autoInstall) return
    clearInstallTimer()
    set({ showModal: true, installCountdown: INSTALL_COUNTDOWN_SECONDS })
    installTimer = setInterval(() => {
      const remaining = (useUpdateStore.getState().installCountdown ?? 0) - 1
      if (remaining > 0) {
        set({ installCountdown: remaining })
        return
      }
      clearInstallTimer()
      set({ installCountdown: 0 })
      useUpdateStore.getState().installUpdate()
    }, 1000)
  },

  setProgress: (percent, bytesPerSecond, transferred, total) => {
    set({
      downloadProgress: percent,
      downloadSpeed: bytesPerSecond ?? 0,
      downloadTransferred: transferred ?? 0,
      downloadTotal: total ?? 0
    })
  },

  setError: (message) => {
    clearWatchdog()
    set({ status: 'error', errorMessage: message })
    useToastStore.getState().addToast({ type: 'error', message: `Update check failed: ${message}` })
  },

  /**
   * The install was dispatched but the app is still running. Status stays 'ready'
   * on purpose: 'error' would remove the Restart button, and this failure is
   * retryable — main has already released the latch that made the first click stick.
   */
  setInstallFailed: (message) => {
    clearInstallTimer()
    set({ status: 'ready', installCountdown: null })
    useToastStore.getState().addToast({ type: 'error', message })
  }
}))
