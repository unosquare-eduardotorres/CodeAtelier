import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type {
  Specialist,
  CreateSpecialistInput,
  UpdateSpecialistInput
} from '../../../shared/types'

interface SpecialistState {
  specialists: Specialist[]
  isLoading: boolean
  error: string | null

  loadSpecialists: () => Promise<void>
  createSpecialist: (data: CreateSpecialistInput) => Promise<void>
  updateSpecialist: (id: string, data: UpdateSpecialistInput) => Promise<void>
  deleteSpecialist: (id: string) => Promise<{ success: boolean; error?: string }>
  assignSkill: (specialistId: string, skillId: string) => Promise<void>
  removeSkill: (specialistId: string, skillId: string) => Promise<void>
}

export const useSpecialistStore = create<SpecialistState>((set, get) => ({
  specialists: [],
  isLoading: false,
  error: null,

  loadSpecialists: async () => {
    set({ isLoading: true, error: null })
    try {
      const specialists = await window.api.listSpecialists()
      set({ specialists, isLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load specialists:', error)
      set({ isLoading: false, error: (error as Error).message })
    }
  },

  createSpecialist: async (data: CreateSpecialistInput) => {
    try {
      const specialist = await window.api.createSpecialist(data)
      set((state) => ({ specialists: [...state.specialists, specialist], error: null }))
    } catch (error) {
      rendererLog.error('Failed to create specialist:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  updateSpecialist: async (id: string, data: UpdateSpecialistInput) => {
    try {
      const updated = await window.api.updateSpecialist({ id, ...data })
      set((state) => ({
        specialists: state.specialists.map((s) => (s.id === id ? updated : s)),
        error: null
      }))
    } catch (error) {
      rendererLog.error('Failed to update specialist:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  deleteSpecialist: async (id: string) => {
    try {
      await window.api.deleteSpecialist({ id })
      set((state) => ({
        specialists: state.specialists.filter((s) => s.id !== id),
        error: null
      }))
      return { success: true }
    } catch (error) {
      const message = (error as Error).message
      rendererLog.error('Failed to delete specialist:', message)
      set({ error: message })
      return { success: false, error: message }
    }
  },

  assignSkill: async (specialistId: string, skillId: string) => {
    try {
      await window.api.assignSkillToSpecialist({ specialistId, skillId })
      // Reload to get updated data
      await get().loadSpecialists()
    } catch (error) {
      rendererLog.error('Failed to assign skill:', error)
      set({ error: (error as Error).message })
      throw error
    }
  },

  removeSkill: async (specialistId: string, skillId: string) => {
    try {
      await window.api.removeSkillFromSpecialist({ specialistId, skillId })
      await get().loadSpecialists()
    } catch (error) {
      rendererLog.error('Failed to remove skill:', error)
      set({ error: (error as Error).message })
      throw error
    }
  }
}))
