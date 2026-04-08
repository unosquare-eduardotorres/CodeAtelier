import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { UserProfile, CoreAgentPrompt } from '../../../shared/types'

interface ProfileState {
  profile: UserProfile | null
  coreAgentPrompts: CoreAgentPrompt[]
  isLoading: boolean
  hasCompletedWelcome: boolean

  loadProfile: () => Promise<void>
  saveProfile: (displayName: string, avatarKey: string) => Promise<void>

  // Core Agent Prompts
  loadCoreAgentPrompts: () => Promise<void>
  saveCoreAgentPrompt: (
    agentRole: 'generalist',
    mode: 'plan' | 'build',
    promptText: string
  ) => Promise<void>
  resetCoreAgentPrompt: (agentRole: 'generalist', mode: 'plan' | 'build') => Promise<void>
  getCoreAgentPrompt: (
    agentRole: 'generalist',
    mode: 'plan' | 'build'
  ) => CoreAgentPrompt | undefined
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: null,
  coreAgentPrompts: [],
  isLoading: true,
  hasCompletedWelcome: false,

  loadProfile: async () => {
    set({ isLoading: true })
    try {
      // Try to read from user specialist record first
      const specialists = await window.api.listSpecialists()
      const userSpec = specialists.find((s) => s.agentId === 'user')
      if (userSpec) {
        set({
          profile: {
            id: userSpec.id,
            displayName: userSpec.alias ?? userSpec.displayName,
            avatarKey: userSpec.avatarUrl ?? 'business-man',
            pixelSpriteId: userSpec.pixelSpriteId ?? null,
            usePixelForChat: userSpec.usePixelForChat ?? false,
            createdAt: userSpec.createdAt,
            updatedAt: userSpec.updatedAt
          },
          hasCompletedWelcome: true,
          isLoading: false
        })
      } else {
        // Fallback to legacy user_profile table
        const profile = await window.api.getUserProfile()
        set({
          profile: profile ? { ...profile, pixelSpriteId: null, usePixelForChat: false } : null,
          hasCompletedWelcome: profile !== null,
          isLoading: false
        })
      }
    } catch (error) {
      rendererLog.error('Failed to load user profile:', error)
      set({ isLoading: false })
    }
  },

  saveProfile: async (displayName: string, avatarKey: string) => {
    try {
      // Find user specialist and update it
      const specialists = await window.api.listSpecialists()
      const userSpec = specialists.find((s) => s.agentId === 'user')
      if (userSpec) {
        await window.api.updateSpecialist({
          id: userSpec.id,
          displayName,
          avatarUrl: avatarKey
        })
      } else {
        // Fallback: legacy path
        await window.api.upsertUserProfile({ displayName, avatarKey })
      }
      // Reload to get fresh data
      await get().loadProfile()
    } catch (error) {
      rendererLog.error('Failed to save user profile:', error)
      throw error
    }
  },

  // ── Core Agent Prompts ──

  loadCoreAgentPrompts: async () => {
    try {
      const prompts = await window.api.listCoreAgentPrompts()
      set({ coreAgentPrompts: prompts })
    } catch (error) {
      rendererLog.error('Failed to load core agent prompts:', error)
    }
  },

  saveCoreAgentPrompt: async (
    agentRole: 'generalist',
    mode: 'plan' | 'build',
    promptText: string
  ) => {
    try {
      const updated = await window.api.upsertCoreAgentPrompt({ agentRole, mode, promptText })
      set((state) => ({
        coreAgentPrompts: [
          ...state.coreAgentPrompts.filter((p) => !(p.agentRole === agentRole && p.mode === mode)),
          updated
        ]
      }))
    } catch (error) {
      rendererLog.error('Failed to save core agent prompt:', error)
      throw error
    }
  },

  resetCoreAgentPrompt: async (agentRole: 'generalist', mode: 'plan' | 'build') => {
    try {
      const updated = await window.api.resetCoreAgentPrompt({ agentRole, mode })
      set((state) => ({
        coreAgentPrompts: [
          ...state.coreAgentPrompts.filter((p) => !(p.agentRole === agentRole && p.mode === mode)),
          updated
        ]
      }))
    } catch (error) {
      rendererLog.error('Failed to reset core agent prompt:', error)
      throw error
    }
  },

  getCoreAgentPrompt: (agentRole: 'generalist', mode: 'plan' | 'build') => {
    return get().coreAgentPrompts.find((p) => p.agentRole === agentRole && p.mode === mode)
  }
}))
