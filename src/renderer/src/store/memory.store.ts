import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  MemoryFact,
  MemoryContradiction,
  MemoryFeedProgress,
  MemoryFactCategory,
  MemoryCaptureSettings,
  MemoryEmbeddingStatus,
  MemorySourceType
} from '../../../shared/types'

type FeedSource = MemorySourceType | 'claude-md' | 'codebase' | 'document'
type FeedStatus = 'idle' | 'running' | 'completed' | 'error'

interface MemoryState {
  // Fact state
  facts: MemoryFact[]
  contradictions: MemoryContradiction[]
  searchQuery: string
  embeddingStatus: MemoryEmbeddingStatus | null
  captureSettings: MemoryCaptureSettings | null

  // Feed state
  feedStatus: FeedStatus
  feedSource: FeedSource | null
  feedMessage: string | null
  feedError: string | null

  // Fact actions
  loadFacts: (workspaceId: string) => Promise<void>
  searchFacts: (workspaceId: string, query: string, category?: MemoryFactCategory) => Promise<void>
  archiveFact: (id: string, workspaceId: string) => Promise<void>
  confirmFact: (id: string, workspaceId: string) => Promise<void>
  deleteFact: (id: string) => Promise<void>
  updateFact: (
    id: string,
    params: { title?: string; content?: string; tags?: string[]; scopePaths?: string[]; category?: MemoryFactCategory }
  ) => Promise<void>

  // Scope toggle
  toggleScope: (id: string, global: boolean, workspaceId?: string) => Promise<void>

  // Contradiction actions
  loadContradictions: () => Promise<void>
  resolveContradiction: (id: string, resolution: string, keepFactId: string, archiveFactId?: string) => Promise<void>

  // Capture settings
  loadCaptureSettings: (workspaceId: string) => Promise<void>
  updateCaptureSettings: (workspaceId: string, settings: Partial<MemoryCaptureSettings>) => Promise<void>

  // Embedding actions
  loadEmbeddingStatus: (workspaceId: string) => Promise<void>
  triggerBackfill: () => Promise<void>

  // Search
  setSearchQuery: (query: string) => void

  // Feed actions (retained)
  onFeedProgress: (progress: MemoryFeedProgress) => void
  startFeed: (source: FeedSource) => void
  cancelFeed: () => void
  dismissFeed: () => void
}

export const useMemoryStore = create<MemoryState>((set) => ({
  facts: [],
  contradictions: [],
  searchQuery: '',
  embeddingStatus: null,
  captureSettings: null,
  feedStatus: 'idle',
  feedSource: null,
  feedMessage: null,
  feedError: null,

  // ── Fact actions ──

  loadFacts: async (workspaceId) => {
    try {
      const facts = await window.api.memoryFactsList({ workspaceId })
      set({ facts })
    } catch (error) {
      rendererLog.error('Failed to load facts:', error)
    }
  },

  searchFacts: async (workspaceId, query, category) => {
    try {
      const facts = await window.api.memoryFactsSearch({ workspaceId, query, category })
      set({ facts, searchQuery: query })
    } catch (error) {
      rendererLog.error('Failed to search facts:', error)
    }
  },

  archiveFact: async (id, _workspaceId) => {
    try {
      await window.api.memoryFactsArchive({ id })
      set((state) => ({
        facts: state.facts.filter((f) => f.id !== id)
      }))
    } catch (error) {
      rendererLog.error('Failed to archive fact:', error)
    }
  },

  confirmFact: async (id, _workspaceId) => {
    try {
      const confirmed = await window.api.memoryFactsConfirm({ id })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? confirmed : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to confirm fact:', error)
    }
  },

  deleteFact: async (id) => {
    try {
      await window.api.memoryFactsDelete({ id })
      set((state) => ({
        facts: state.facts.filter((f) => f.id !== id)
      }))
    } catch (error) {
      rendererLog.error('Failed to delete fact:', error)
    }
  },

  updateFact: async (id, params) => {
    try {
      const updated = await window.api.memoryFactsUpdate({ id, ...params })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? updated : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to update fact:', error)
    }
  },

  // ── Scope toggle ──

  toggleScope: async (id, global, workspaceId) => {
    try {
      const updated = await window.api.memoryFactsScopeToggle({ id, global, workspaceId })
      set((state) => ({
        facts: state.facts.map((f) => (f.id === id ? updated : f))
      }))
    } catch (error) {
      rendererLog.error('Failed to toggle scope:', error)
    }
  },

  // ── Contradictions ──

  loadContradictions: async () => {
    try {
      const contradictions = await window.api.memoryContradictionsList()
      set({ contradictions })
    } catch (error) {
      rendererLog.error('Failed to load contradictions:', error)
    }
  },

  resolveContradiction: async (id, resolution, keepFactId, archiveFactId) => {
    try {
      await window.api.memoryContradictionsResolve({ id, resolution, keepFactId, archiveFactId })
      set((state) => ({
        contradictions: state.contradictions.filter((c) => c.id !== id)
      }))
    } catch (error) {
      rendererLog.error('Failed to resolve contradiction:', error)
    }
  },

  // ── Capture settings ──

  loadCaptureSettings: async (workspaceId) => {
    try {
      const captureSettings = await window.api.memoryCaptureSettingsGet({ workspaceId })
      set({ captureSettings })
    } catch (error) {
      rendererLog.error('Failed to load capture settings:', error)
    }
  },

  updateCaptureSettings: async (workspaceId, settings) => {
    try {
      await window.api.memoryCaptureSettingsSet({ workspaceId, settings })
      set((state) => ({
        captureSettings: state.captureSettings
          ? { ...state.captureSettings, ...settings }
          : null
      }))
    } catch (error) {
      rendererLog.error('Failed to update capture settings:', error)
    }
  },

  // ── Embedding status ──

  loadEmbeddingStatus: async (workspaceId) => {
    try {
      const embeddingStatus = await window.api.memoryEmbeddingStatus({ workspaceId })
      set({ embeddingStatus })
    } catch (error) {
      rendererLog.error('Failed to load embedding status:', error)
    }
  },

  triggerBackfill: async () => {
    try {
      await window.api.memoryEmbeddingBackfill()
    } catch (error) {
      rendererLog.error('Failed to trigger backfill:', error)
    }
  },

  // ── Search ──

  setSearchQuery: (query) => set({ searchQuery: query }),

  // ── Feed (retained) ──

  startFeed: (source) => {
    set({ feedStatus: 'running', feedSource: source, feedMessage: 'Starting...', feedError: null })
  },

  onFeedProgress: (progress) => {
    if (progress.status === 'error') {
      set({ feedStatus: 'error', feedError: progress.message })
    } else if (progress.status === 'done') {
      set({ feedStatus: 'completed', feedMessage: progress.message, feedSource: progress.source as FeedSource })
    } else {
      set({ feedMessage: progress.message })
    }
  },

  cancelFeed: () => {
    window.api.memoryFeedCancel().catch(() => {})
    set({ feedStatus: 'idle', feedSource: null, feedMessage: null, feedError: null })
  },

  dismissFeed: () => {
    set({ feedStatus: 'idle', feedSource: null, feedMessage: null, feedError: null })
  }
}))
