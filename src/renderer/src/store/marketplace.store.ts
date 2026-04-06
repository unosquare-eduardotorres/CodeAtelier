import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { MarketplaceSpecialist, Skill, Specialist } from '../../../shared/types'

type MarketplaceFilter = 'all' | 'active' | 'available'

interface MarketplaceState {
  specialists: MarketplaceSpecialist[]
  skills: Skill[]
  filter: MarketplaceFilter
  searchQuery: string
  isLoading: boolean
  activatingIds: Set<string>
  error: string | null

  // Actions
  loadMarketplace: (workspacePath: string) => Promise<void>
  activateSpecialist: (workspacePath: string, specialistId: string) => Promise<void>
  deactivateSpecialist: (workspacePath: string, specialistId: string) => Promise<void>
  updateConfig: (
    id: string,
    data: {
      displayName?: string
      icon?: string
      color?: string
      alias?: string | null
      avatarUrl?: string | null
      priority?: number
    }
  ) => Promise<Specialist | null>
  activateAll: (workspacePath: string) => Promise<void>
  setFilter: (filter: MarketplaceFilter) => void
  setSearchQuery: (query: string) => void
  reset: () => void
}

const initialState = {
  specialists: [] as MarketplaceSpecialist[],
  skills: [] as Skill[],
  filter: 'all' as MarketplaceFilter,
  searchQuery: '',
  isLoading: false,
  activatingIds: new Set<string>(),
  error: null as string | null
}

export const useMarketplaceStore = create<MarketplaceState>((set, get) => ({
  ...initialState,

  loadMarketplace: async (workspacePath: string) => {
    set({ isLoading: true, error: null })
    try {
      const [specialists, skills] = await Promise.all([
        window.api.getMarketplace({ workspacePath }),
        window.api.listSkills()
      ])
      set({ specialists, skills, isLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load marketplace:', error)
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  activateSpecialist: async (workspacePath: string, specialistId: string) => {
    const { activatingIds } = get()
    const newActivating = new Set(activatingIds)
    newActivating.add(specialistId)
    set({ activatingIds: newActivating })

    try {
      await window.api.deploySpecialist({ workspacePath, specialistId })
      // Refresh marketplace data
      const specialists = await window.api.getMarketplace({ workspacePath })
      const updatedActivating = new Set(get().activatingIds)
      updatedActivating.delete(specialistId)
      set({ specialists, activatingIds: updatedActivating })
    } catch (error) {
      rendererLog.error('Failed to activate specialist:', error)
      const updatedActivating = new Set(get().activatingIds)
      updatedActivating.delete(specialistId)
      set({ activatingIds: updatedActivating, error: (error as Error).message })
    }
  },

  deactivateSpecialist: async (workspacePath: string, specialistId: string) => {
    const { activatingIds } = get()
    const newActivating = new Set(activatingIds)
    newActivating.add(specialistId)
    set({ activatingIds: newActivating })

    try {
      await window.api.undeploySpecialist({ workspacePath, specialistId })
      // Refresh marketplace data
      const specialists = await window.api.getMarketplace({ workspacePath })
      const updatedActivating = new Set(get().activatingIds)
      updatedActivating.delete(specialistId)
      set({ specialists, activatingIds: updatedActivating })
    } catch (error) {
      rendererLog.error('Failed to deactivate specialist:', error)
      const updatedActivating = new Set(get().activatingIds)
      updatedActivating.delete(specialistId)
      set({ activatingIds: updatedActivating, error: (error as Error).message })
    }
  },

  updateConfig: async (id, data) => {
    try {
      const updated = await window.api.updateSpecialistConfig({ id, ...data })
      // Update the specialist in local state
      set((state) => ({
        specialists: state.specialists.map((s) =>
          s.id === id
            ? {
                ...s,
                displayName: data.displayName ?? s.displayName,
                icon: data.icon ?? s.icon,
                color: data.color ?? s.color,
                alias: data.alias !== undefined ? data.alias : s.alias,
                avatarUrl: data.avatarUrl !== undefined ? data.avatarUrl : s.avatarUrl,
                priority: data.priority ?? s.priority
              }
            : s
        )
      }))
      return updated
    } catch (error) {
      rendererLog.error('Failed to update specialist config:', error)
      return null
    }
  },

  activateAll: async (workspacePath: string) => {
    const { specialists } = get()
    const inactiveIds = specialists.filter((s) => !s.isActive).map((s) => s.id)
    const newActivating = new Set(inactiveIds)
    set({ activatingIds: newActivating })

    try {
      // Activate each inactive specialist sequentially to avoid race conditions
      for (const id of inactiveIds) {
        await window.api.deploySpecialist({ workspacePath, specialistId: id })
      }
      // Refresh marketplace data
      const updatedSpecialists = await window.api.getMarketplace({ workspacePath })
      set({ specialists: updatedSpecialists, activatingIds: new Set() })
    } catch (error) {
      rendererLog.error('Failed to activate all specialists:', error)
      set({ activatingIds: new Set(), error: (error as Error).message })
    }
  },

  setFilter: (filter: MarketplaceFilter) => {
    set({ filter })
  },

  setSearchQuery: (searchQuery: string) => {
    set({ searchQuery })
  },

  reset: () => {
    set(initialState)
  }
}))
