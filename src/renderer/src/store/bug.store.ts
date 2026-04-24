import { create } from 'zustand'
import type { BugRecord } from '../../../shared/types'

export interface BugFilters {
  process?: 'main' | 'renderer' | 'preload'
  isResolved?: boolean
  workspaceId?: string
  sortBy?: 'last_seen_at' | 'occurrence_count' | 'severity'
  sortDir?: 'asc' | 'desc'
}

interface BugStore {
  bugs: BugRecord[]
  unresolvedCount: number
  filters: BugFilters
  isLoading: boolean
  selectedBugId: string | null

  fetchBugs: () => Promise<void>
  fetchCount: () => Promise<void>
  setFilters: (filters: Partial<BugFilters>) => void
  setSelectedBugId: (id: string | null) => void
  resolveBug: (id: string) => Promise<void>
  unresolveBug: (id: string) => Promise<void>
  deleteBug: (id: string) => Promise<void>
  updateNote: (id: string, note: string) => Promise<void>
}

export const useBugStore = create<BugStore>((set, get) => ({
  bugs: [],
  unresolvedCount: 0,
  filters: { sortBy: 'last_seen_at', sortDir: 'desc' },
  isLoading: false,
  selectedBugId: null,

  fetchBugs: async () => {
    set({ isLoading: true })
    try {
      const bugs = (await window.api.getBugs(get().filters)) as BugRecord[]
      set({ bugs, isLoading: false })
    } catch (error) {
      console.error('[BugStore] Failed to fetch bugs:', error)
      set({ isLoading: false })
    }
  },

  fetchCount: async () => {
    try {
      const count = await window.api.getBugCount()
      set({ unresolvedCount: count })
    } catch (error) {
      console.error('[BugStore] Failed to fetch count:', error)
    }
  },

  setFilters: (filters) => {
    set((state) => ({ filters: { ...state.filters, ...filters } }))
    // Re-fetch with new filters
    get().fetchBugs()
  },

  setSelectedBugId: (id) => set({ selectedBugId: id }),

  resolveBug: async (id) => {
    await window.api.resolveBug({ id })
    // Optimistic update
    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? { ...b, isResolved: true } : b)),
      unresolvedCount: Math.max(0, state.unresolvedCount - 1)
    }))
  },

  unresolveBug: async (id) => {
    await window.api.unresolveBug({ id })
    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? { ...b, isResolved: false } : b)),
      unresolvedCount: state.unresolvedCount + 1
    }))
  },

  deleteBug: async (id) => {
    const bug = get().bugs.find((b) => b.id === id)
    await window.api.deleteBug({ id })
    set((state) => ({
      bugs: state.bugs.filter((b) => b.id !== id),
      unresolvedCount:
        bug && !bug.isResolved
          ? Math.max(0, state.unresolvedCount - 1)
          : state.unresolvedCount,
      selectedBugId: state.selectedBugId === id ? null : state.selectedBugId
    }))
  },

  updateNote: async (id, note) => {
    await window.api.updateBugNote({ id, note })
    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? { ...b, note } : b))
    }))
  }
}))
