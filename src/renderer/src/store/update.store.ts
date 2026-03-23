import { create } from 'zustand'

type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  downloadProgress: number
  errorMessage: string | null

  // Actions
  checkForUpdates: () => void
  downloadUpdate: () => void
  installUpdate: () => void
  dismiss: () => void

  // Internal setters (called from App.tsx listener wiring)
  setAvailable: (version: string, releaseNotes?: string) => void
  setNotAvailable: () => void
  setDownloaded: (version: string) => void
  setProgress: (percent: number) => void
  setError: (message: string) => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  downloadProgress: 0,
  errorMessage: null,

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
    set({ status: 'idle' })
  },

  // Internal setters
  setAvailable: (version, releaseNotes) => {
    set({
      status: 'available',
      availableVersion: version,
      releaseNotes: releaseNotes ?? null
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
