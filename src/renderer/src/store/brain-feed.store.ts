import { create } from 'zustand'
import type { BrainFeedProgress } from '../../../shared/types'

type FeedSource = 'claude-md' | 'codebase' | 'document'
type FeedStatus = 'idle' | 'running' | 'completed' | 'error'

interface BrainFeedState {
  status: FeedStatus
  source: FeedSource | null
  message: string | null
  error: string | null

  // Actions — called from App.tsx listener
  onProgress: (progress: BrainFeedProgress) => void

  // Actions — called from BrainSettingsPage
  startFeed: (source: FeedSource) => void
  cancelFeed: () => void
  dismiss: () => void
}

export const useBrainFeedStore = create<BrainFeedState>((set) => ({
  status: 'idle',
  source: null,
  message: null,
  error: null,

  startFeed: (source) => {
    set({ status: 'running', source, message: 'Starting...', error: null })
  },

  onProgress: (progress) => {
    if (progress.type === 'error') {
      set({ status: 'error', error: progress.message })
    } else if (progress.type === 'complete') {
      set({ status: 'completed', message: progress.message, source: progress.source })
    } else {
      set({ message: progress.message })
    }
  },

  cancelFeed: () => {
    window.api.brainFeedCancel().catch(() => {})
    set({ status: 'idle', source: null, message: null, error: null })
  },

  dismiss: () => {
    set({ status: 'idle', source: null, message: null, error: null })
  }
}))
