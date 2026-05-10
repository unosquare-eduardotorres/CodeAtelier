import { create } from 'zustand'
import type { UpdateConfig, UpdateSourceProvider } from '../../../shared/types'

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
  setNotAvailable: () => void
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
    set({
      status: 'available',
      availableVersion: version,
      releaseNotes: releaseNotes ?? null,
      releaseDate: releaseDate ?? null,
      showModal: true // Automatically show modal when update detected
    })
  },

  setNotAvailable: () => {
    set({ status: 'idle' })
  },

  setDownloaded: (version) => {
    set({ status: 'ready', availableVersion: version })
  },

  setProgress: (percent) => {
    set({ downloadProgress: percent })
  },

  setError: (message) => {
    set({ status: 'error', errorMessage: message })
  }
}))
