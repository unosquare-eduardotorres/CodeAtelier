import { create } from 'zustand'
import type { UpdateConfig, UpdateSourceProvider } from '../../../shared/types'
import { useToastStore } from './toast.store'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  releaseDate: string | null
  downloadProgress: number
  errorMessage: string | null

  // Modal visibility
  showModal: boolean

  // Update config
  config: UpdateConfig
  configLoaded: boolean

  // Actions
  checkForUpdates: () => void
  downloadUpdate: () => void
  installUpdate: () => void
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
  setDownloaded: (version: string) => void
  setProgress: (percent: number) => void
  setError: (message: string) => void
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

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  releaseDate: null,
  downloadProgress: 0,
  errorMessage: null,
  showModal: false,
  config: { ...DEFAULT_CONFIG },
  configLoaded: false,

  checkForUpdates: () => {
    set({ status: 'checking', errorMessage: null })
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
    set({ status: 'downloading', downloadProgress: 0 })
    window.api.downloadUpdate()
  },

  installUpdate: () => {
    window.api.installUpdate()
  },

  dismiss: () => {
    set({ status: 'idle', showModal: false })
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

  closeModal: () => set({ showModal: false }),

  // Internal setters
  setAvailable: (version, releaseNotes, releaseDate) => {
    clearWatchdog()
    set({
      status: 'available',
      availableVersion: version,
      releaseNotes: releaseNotes ?? null,
      releaseDate: releaseDate ?? null,
      showModal: true // Automatically show modal when update detected
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

  setDownloaded: (version) => {
    clearWatchdog()
    set({ status: 'ready', availableVersion: version })
  },

  setProgress: (percent) => {
    set({ downloadProgress: percent })
  },

  setError: (message) => {
    clearWatchdog()
    set({ status: 'error', errorMessage: message })
    useToastStore.getState().addToast({ type: 'error', message: `Update check failed: ${message}` })
  }
}))
