import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { UserProfile, CoreAgentAlias } from '../../../shared/types'

interface ProfileState {
  profile: UserProfile | null
  coreAgentAliases: CoreAgentAlias[]
  isLoading: boolean
  hasCompletedWelcome: boolean

  loadProfile: () => Promise<void>
  saveProfile: (displayName: string, avatarKey: string) => Promise<void>
  loadCoreAgentAliases: () => Promise<void>
  saveCoreAgentAlias: (
    agentRole: 'generalist' | 'coordinator',
    alias: string | null,
    avatarKey: string | null
  ) => Promise<void>
  getCoreAgentAlias: (role: 'generalist' | 'coordinator') => CoreAgentAlias | undefined
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: null,
  coreAgentAliases: [],
  isLoading: true,
  hasCompletedWelcome: false,

  loadProfile: async () => {
    set({ isLoading: true })
    try {
      const profile = await window.api.getUserProfile()
      set({
        profile,
        hasCompletedWelcome: profile !== null,
        isLoading: false
      })
      // Also load core agent aliases
      await get().loadCoreAgentAliases()
    } catch (error) {
      rendererLog.error('Failed to load user profile:', error)
      set({ isLoading: false })
    }
  },

  saveProfile: async (displayName: string, avatarKey: string) => {
    try {
      const profile = await window.api.upsertUserProfile({ displayName, avatarKey })
      set({ profile, hasCompletedWelcome: true })
    } catch (error) {
      rendererLog.error('Failed to save user profile:', error)
      throw error
    }
  },

  loadCoreAgentAliases: async () => {
    try {
      const aliases = await window.api.listCoreAgentAliases()
      set({ coreAgentAliases: aliases })
    } catch (error) {
      rendererLog.error('Failed to load core agent aliases:', error)
    }
  },

  saveCoreAgentAlias: async (
    agentRole: 'generalist' | 'coordinator',
    alias: string | null,
    avatarKey: string | null
  ) => {
    try {
      const updated = await window.api.upsertCoreAgentAlias({ agentRole, alias, avatarKey })
      set((state) => ({
        coreAgentAliases: [
          ...state.coreAgentAliases.filter((a) => a.agentRole !== agentRole),
          updated
        ]
      }))
    } catch (error) {
      rendererLog.error('Failed to save core agent alias:', error)
      throw error
    }
  },

  getCoreAgentAlias: (role: 'generalist' | 'coordinator') => {
    return get().coreAgentAliases.find((a) => a.agentRole === role)
  }
}))
