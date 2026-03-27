import { create } from 'zustand'
import type { Memory, MemoryFeedProgress, MemoryType } from '../../../shared/types'

type FeedSource = 'claude-md' | 'codebase' | 'document'
type FeedStatus = 'idle' | 'running' | 'completed' | 'error'

interface MemoryState {
  memories: Memory[]
  searchQuery: string
  feedStatus: FeedStatus
  feedSource: FeedSource | null
  feedMessage: string | null
  feedError: string | null

  // Memory CRUD actions
  loadMemories: (workspaceId: string) => Promise<void>
  searchMemories: (workspaceId: string, query: string) => Promise<void>
  createMemory: (params: {
    workspaceId: string | null
    type: MemoryType
    title: string
    content: string
    tags?: string[]
    importance?: number
  }) => Promise<void>
  updateMemory: (
    id: string,
    params: { title?: string; content?: string; tags?: string[]; importance?: number }
  ) => Promise<void>
  deleteMemory: (id: string) => Promise<void>
  setSearchQuery: (query: string) => void

  // Feed actions
  onFeedProgress: (progress: MemoryFeedProgress) => void
  startFeed: (source: FeedSource) => void
  cancelFeed: () => void
  dismissFeed: () => void
}

export const useMemoryStore = create<MemoryState>((set) => ({
  memories: [],
  searchQuery: '',
  feedStatus: 'idle',
  feedSource: null,
  feedMessage: null,
  feedError: null,

  loadMemories: async (workspaceId) => {
    try {
      const memories = await window.api.listMemories({ workspaceId })
      set({ memories })
    } catch (error) {
      console.error('Failed to load memories:', error)
    }
  },

  searchMemories: async (workspaceId, query) => {
    try {
      const memories = await window.api.searchMemories({ workspaceId, query })
      set({ memories, searchQuery: query })
    } catch (error) {
      console.error('Failed to search memories:', error)
    }
  },

  createMemory: async (params) => {
    try {
      await window.api.createMemory(params)
      if (params.workspaceId) {
        const memories = await window.api.listMemories({
          workspaceId: params.workspaceId
        })
        set({ memories })
      }
    } catch (error) {
      console.error('Failed to create memory:', error)
    }
  },

  updateMemory: async (id, params) => {
    try {
      const updated = await window.api.updateMemory({ id, ...params })
      set((state) => ({
        memories: state.memories.map((m) => (m.id === id ? updated : m))
      }))
    } catch (error) {
      console.error('Failed to update memory:', error)
    }
  },

  deleteMemory: async (id) => {
    try {
      await window.api.deleteMemory({ id })
      set((state) => ({
        memories: state.memories.filter((m) => m.id !== id)
      }))
    } catch (error) {
      console.error('Failed to delete memory:', error)
    }
  },

  setSearchQuery: (query) => set({ searchQuery: query }),

  startFeed: (source) => {
    set({ feedStatus: 'running', feedSource: source, feedMessage: 'Starting...', feedError: null })
  },

  onFeedProgress: (progress) => {
    if (progress.type === 'error') {
      set({ feedStatus: 'error', feedError: progress.message })
    } else if (progress.type === 'complete') {
      set({
        feedStatus: 'completed',
        feedMessage: progress.message,
        feedSource: progress.source
      })
    } else {
      set({ feedMessage: progress.message })
    }
  },

  cancelFeed: () => {
    window.api.memoryFeedCancel().catch(() => {})
    set({
      feedStatus: 'idle',
      feedSource: null,
      feedMessage: null,
      feedError: null
    })
  },

  dismissFeed: () => {
    set({
      feedStatus: 'idle',
      feedSource: null,
      feedMessage: null,
      feedError: null
    })
  }
}))
