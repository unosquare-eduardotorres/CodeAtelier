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

  // Search
  searchQuery: string
  setSearchQuery: (query: string) => void

  // Selection state
  selectedBugIds: Set<string>
  toggleBugSelection: (id: string, shiftKey: boolean) => void
  selectAllBugs: (ids?: string[]) => void
  deselectAllBugs: () => void

  // Bulk actions
  bulkResolveBugs: (ids: string[]) => Promise<void>
  bulkDeleteBugs: (ids: string[]) => Promise<void>

  fetchBugs: () => Promise<void>
  fetchCount: () => Promise<void>
  setFilters: (filters: Partial<BugFilters>) => void
  setSelectedBugId: (id: string | null) => void
  resolveBug: (id: string) => Promise<void>
  unresolveBug: (id: string) => Promise<void>
  deleteBug: (id: string) => Promise<void>
  updateNote: (id: string, note: string) => Promise<void>
}

let _lastToggledIndex = -1

export const useBugStore = create<BugStore>((set, get) => ({
  bugs: [],
  unresolvedCount: 0,
  filters: { sortBy: 'last_seen_at', sortDir: 'desc' },
  isLoading: false,
  selectedBugId: null,
  selectedBugIds: new Set<string>(),

  searchQuery: '',

  setSearchQuery: (query) => {
    set({ searchQuery: query })
  },

  toggleBugSelection: (id, shiftKey) => {
    const { bugs, selectedBugIds } = get()
    const currentIndex = bugs.findIndex((b) => b.id === id)
    if (currentIndex === -1) return

    if (shiftKey && _lastToggledIndex >= 0 && _lastToggledIndex < bugs.length) {
      const start = Math.min(_lastToggledIndex, currentIndex)
      const end = Math.max(_lastToggledIndex, currentIndex)
      const next = new Set(selectedBugIds)
      for (let i = start; i <= end; i++) {
        next.add(bugs[i].id)
      }
      set({ selectedBugIds: next })
    } else {
      const next = new Set(selectedBugIds)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      set({ selectedBugIds: next })
    }
    _lastToggledIndex = currentIndex
  },

  selectAllBugs: (ids) => {
    const effectiveIds = ids ?? get().bugs.map((b) => b.id)
    set({ selectedBugIds: new Set(effectiveIds) })
  },

  deselectAllBugs: () => {
    set({ selectedBugIds: new Set<string>() })
    _lastToggledIndex = -1
  },

  bulkResolveBugs: async (ids) => {
    await Promise.all(ids.map((id) => window.api.resolveBug({ id })))
    set((state) => ({
      bugs: state.bugs.map((b) => (ids.includes(b.id) ? { ...b, isResolved: true } : b)),
      unresolvedCount: Math.max(
        0,
        state.unresolvedCount - ids.filter((id) => state.bugs.find((b) => b.id === id && !b.isResolved)).length
      ),
      selectedBugIds: new Set<string>()
    }))
    _lastToggledIndex = -1
  },

  bulkDeleteBugs: async (ids) => {
    await Promise.all(ids.map((id) => window.api.deleteBug({ id })))
    set((state) => {
      const deletedUnresolved = ids.filter((id) => state.bugs.find((b) => b.id === id && !b.isResolved)).length
      return {
        bugs: state.bugs.filter((b) => !ids.includes(b.id)),
        unresolvedCount: Math.max(0, state.unresolvedCount - deletedUnresolved),
        selectedBugIds: new Set<string>(),
        selectedBugId: ids.includes(state.selectedBugId ?? '') ? null : state.selectedBugId
      }
    })
    _lastToggledIndex = -1
  },

  fetchBugs: async () => {
    set({ isLoading: true })
    try {
      const bugs = (await window.api.getBugs(get().filters)) as BugRecord[]
      set({ bugs, isLoading: false })
      _lastToggledIndex = -1
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
    // Re-fetch with new filters, then prune stale selections
    get()
      .fetchBugs()
      .then(() => {
        const { bugs, selectedBugIds } = get()
        const validIds = new Set(bugs.map((b) => b.id))
        const pruned = new Set([...selectedBugIds].filter((id) => validIds.has(id)))
        if (pruned.size !== selectedBugIds.size) {
          set({ selectedBugIds: pruned })
        }
      })
      .catch(() => {
        // fetchBugs handles its own errors; clear selections as a safety net
        set({ selectedBugIds: new Set<string>() })
      })
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
    set((state) => {
      const next = new Set(state.selectedBugIds)
      next.delete(id)
      return {
        bugs: state.bugs.filter((b) => b.id !== id),
        unresolvedCount:
          bug && !bug.isResolved ? Math.max(0, state.unresolvedCount - 1) : state.unresolvedCount,
        selectedBugId: state.selectedBugId === id ? null : state.selectedBugId,
        selectedBugIds: next
      }
    })
  },

  updateNote: async (id, note) => {
    await window.api.updateBugNote({ id, note })
    set((state) => ({
      bugs: state.bugs.map((b) => (b.id === id ? { ...b, note } : b))
    }))
  }
}))
