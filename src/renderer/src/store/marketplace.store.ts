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
  deployingIds: Set<string>
  error: string | null

  // Actions
  loadMarketplace: (workspacePath: string) => Promise<void>
  deploySpecialist: (workspacePath: string, specialistId: string) => Promise<void>
  undeploySpecialist: (workspacePath: string, specialistId: string) => Promise<void>
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
  deployAll: (workspacePath: string) => Promise<void>
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
  deployingIds: new Set<string>(),
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

  deploySpecialist: async (workspacePath: string, specialistId: string) => {
    const { deployingIds } = get()
    const newDeploying = new Set(deployingIds)
    newDeploying.add(specialistId)
    set({ deployingIds: newDeploying })

    try {
      await window.api.deploySpecialist({ workspacePath, specialistId })
      // Refresh marketplace data
      const specialists = await window.api.getMarketplace({ workspacePath })
      const updatedDeploying = new Set(get().deployingIds)
      updatedDeploying.delete(specialistId)
      set({ specialists, deployingIds: updatedDeploying })
    } catch (error) {
      rendererLog.error('Failed to deploy specialist:', error)
      const updatedDeploying = new Set(get().deployingIds)
      updatedDeploying.delete(specialistId)
      set({ deployingIds: updatedDeploying, error: (error as Error).message })
    }
  },

  undeploySpecialist: async (workspacePath: string, specialistId: string) => {
    const { deployingIds } = get()
    const newDeploying = new Set(deployingIds)
    newDeploying.add(specialistId)
    set({ deployingIds: newDeploying })

    try {
      await window.api.undeploySpecialist({ workspacePath, specialistId })
      // Refresh marketplace data
      const specialists = await window.api.getMarketplace({ workspacePath })
      const updatedDeploying = new Set(get().deployingIds)
      updatedDeploying.delete(specialistId)
      set({ specialists, deployingIds: updatedDeploying })
    } catch (error) {
      rendererLog.error('Failed to undeploy specialist:', error)
      const updatedDeploying = new Set(get().deployingIds)
      updatedDeploying.delete(specialistId)
      set({ deployingIds: updatedDeploying, error: (error as Error).message })
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

  deployAll: async (workspacePath: string) => {
    const { specialists } = get()
    const inactiveIds = specialists.filter((s) => !s.isActive).map((s) => s.id)
    const newDeploying = new Set(inactiveIds)
    set({ deployingIds: newDeploying })

    try {
      // Deploy each inactive specialist sequentially to avoid race conditions
      for (const id of inactiveIds) {
        await window.api.deploySpecialist({ workspacePath, specialistId: id })
      }
      // Refresh marketplace data
      const updatedSpecialists = await window.api.getMarketplace({ workspacePath })
      set({ specialists: updatedSpecialists, deployingIds: new Set() })
    } catch (error) {
      rendererLog.error('Failed to deploy all specialists:', error)
      set({ deployingIds: new Set(), error: (error as Error).message })
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
