import { create } from 'zustand'
import type { Skill } from '../../../shared/types'

interface SkillState {
  skills: Skill[]
  isLoading: boolean
  error: string | null
  importingSkill: boolean

  loadSkills: () => Promise<void>
  importSkill: (filePath: string) => Promise<{ success: boolean; error?: string }>
  updateSkill: (id: string, data: { name?: string; description?: string }) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  activateSkill: (id: string) => Promise<{ success: boolean; error?: string }>
  deactivateSkill: (id: string) => Promise<{ success: boolean; error?: string }>
}

export const useSkillStore = create<SkillState>((set) => ({
  skills: [],
  isLoading: false,
  error: null,
  importingSkill: false,

  loadSkills: async () => {
    set({ isLoading: true, error: null })
    try {
      const skills = await window.api.listSkills()
      set({ skills, isLoading: false })
    } catch (error) {
      console.error('Failed to load skills:', error)
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  importSkill: async (filePath: string) => {
    set({ importingSkill: true, error: null })
    try {
      const skill = await window.api.importSkill({ filePath })
      set((state) => ({
        skills: [...state.skills, skill],
        importingSkill: false,
        error: null
      }))
      return { success: true }
    } catch (error) {
      const message = (error as Error).message
      console.error('Failed to import skill:', message)
      set({ importingSkill: false, error: message })
      return { success: false, error: message }
    }
  },

  updateSkill: async (id: string, data: { name?: string; description?: string }) => {
    try {
      const updated = await window.api.updateSkill({ id, ...data })
      set((state) => ({
        skills: state.skills.map((s) => (s.id === id ? updated : s)),
        error: null
      }))
    } catch (error) {
      console.error('Failed to update skill:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  deleteSkill: async (id: string) => {
    try {
      await window.api.deleteSkill({ id })
      set((state) => ({
        skills: state.skills.filter((s) => s.id !== id),
        error: null
      }))
    } catch (error) {
      console.error('Failed to delete skill:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  activateSkill: async (id: string) => {
    set({ error: null })
    try {
      const updated = await window.api.activateSkill({ id })
      set((state) => ({
        skills: state.skills.map((s) => (s.id === id ? updated : s)),
        error: null
      }))
      return { success: true }
    } catch (error) {
      const message = (error as Error).message
      console.error('Failed to activate skill:', message)
      set({ error: message })
      return { success: false, error: message }
    }
  },

  deactivateSkill: async (id: string) => {
    set({ error: null })
    try {
      const updated = await window.api.deactivateSkill({ id })
      set((state) => ({
        skills: state.skills.map((s) => (s.id === id ? updated : s)),
        error: null
      }))
      return { success: true }
    } catch (error) {
      const message = (error as Error).message
      console.error('Failed to deactivate skill:', message)
      set({ error: message })
      return { success: false, error: message }
    }
  }
}))
