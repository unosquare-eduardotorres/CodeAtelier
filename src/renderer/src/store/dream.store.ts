import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { DreamRun, DreamProgress } from '../../../shared/types'

interface DreamState {
  currentRun: DreamRun | null
  history: DreamRun[]
  progress: DreamProgress | null

  // Actions
  triggerDream: (workspaceId: string) => Promise<void>
  cancelDream: (workspaceId: string) => Promise<void>
  loadStatus: (workspaceId: string) => Promise<void>
  loadHistory: (workspaceId: string) => Promise<void>
  onProgress: (progress: DreamProgress) => void
  reset: () => void
}

export const useDreamStore = create<DreamState>((set) => ({
  currentRun: null,
  history: [],
  progress: null,

  triggerDream: async (workspaceId) => {
    try {
      const run = await window.api.triggerDream({ workspaceId })
      set({ currentRun: run })
    } catch (error) {
      rendererLog.error('Failed to trigger dream:', error)
    }
  },

  cancelDream: async (workspaceId) => {
    try {
      await window.api.cancelDream({ workspaceId })
      set({ currentRun: null, progress: null })
    } catch (error) {
      rendererLog.error('Failed to cancel dream:', error)
    }
  },

  loadStatus: async (workspaceId) => {
    try {
      const run = await window.api.getDreamStatus({ workspaceId })
      set({ currentRun: run })
    } catch (error) {
      rendererLog.error('Failed to load dream status:', error)
    }
  },

  loadHistory: async (workspaceId) => {
    try {
      const history = await window.api.getDreamHistory({ workspaceId })
      set({ history })
    } catch (error) {
      rendererLog.error('Failed to load dream history:', error)
    }
  },

  onProgress: (progress) => {
    set({ progress })
    if (progress.phase === 'complete') {
      set({ currentRun: null })
    }
  },

  reset: () => set({ currentRun: null, history: [], progress: null })
}))
