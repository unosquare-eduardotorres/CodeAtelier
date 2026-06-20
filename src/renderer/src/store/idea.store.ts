import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { Idea, Conversation } from '../../../shared/types'

interface IdeaState {
  ideas: Idea[]
  isLoading: boolean
  /** STORE-02: Surface mutation errors to the UI */
  error: string | null

  loadIdeas: (workspaceId: string) => Promise<void>
  createIdea: (workspaceId: string, title: string, description: string) => Promise<Idea>
  updateIdea: (id: string, data: { title?: string; description?: string }) => Promise<void>
  deleteIdea: (id: string) => Promise<void>
  startGrill: (
    ideaId: string,
    workspaceId: string
  ) => Promise<{ idea: Idea; conversation: Conversation }>
  convertDirect: (
    ideaId: string,
    workspaceId: string
  ) => Promise<{ idea: Idea; conversation: Conversation }>
  completeFromGrill: (conversationId: string, summary?: string) => Promise<Idea | null>
  reset: () => void
}

export const useIdeaStore = create<IdeaState>((set) => ({
  ideas: [],
  isLoading: false,
  error: null,

  loadIdeas: async (workspaceId) => {
    set({ isLoading: true, error: null })
    try {
      const ideas = await window.api.listIdeas({ workspaceId })
      set({ ideas, isLoading: false })
    } catch (error) {
      rendererLog.error('Failed to load ideas:', error)
      set({ isLoading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  createIdea: async (workspaceId, title, description) => {
    try {
      set({ error: null })
      const idea = await window.api.createIdea({ workspaceId, title, description })
      set((s) => ({ ideas: [idea, ...s.ideas] }))
      return idea
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to create idea:', error)
      set({ error: msg })
      throw error
    }
  },

  updateIdea: async (id, data) => {
    try {
      set({ error: null })
      const updated = await window.api.updateIdea({ id, ...data })
      set((s) => ({ ideas: s.ideas.map((i) => (i.id === id ? updated : i)) }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to update idea:', error)
      set({ error: msg })
      throw error
    }
  },

  deleteIdea: async (id) => {
    try {
      set({ error: null })
      await window.api.deleteIdea({ id })
      set((s) => ({ ideas: s.ideas.filter((i) => i.id !== id) }))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to delete idea:', error)
      set({ error: msg })
      throw error
    }
  },

  startGrill: async (ideaId, workspaceId) => {
    try {
      set({ error: null })
      const result = await window.api.startIdeaGrill({ ideaId, workspaceId })
      set((s) => ({ ideas: s.ideas.map((i) => (i.id === ideaId ? result.idea : i)) }))
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to start grill:', error)
      set({ error: msg })
      throw error
    }
  },

  convertDirect: async (ideaId, workspaceId) => {
    try {
      set({ error: null })
      const result = await window.api.convertIdeaDirect({ ideaId, workspaceId })
      set((s) => ({ ideas: s.ideas.map((i) => (i.id === ideaId ? result.idea : i)) }))
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to convert idea:', error)
      set({ error: msg })
      throw error
    }
  },

  completeFromGrill: async (conversationId, summary) => {
    try {
      set({ error: null })
      const result = await window.api.completeIdeaFromGrill({ conversationId, summary })
      if (result) {
        set((s) => ({ ideas: s.ideas.map((i) => (i.id === result.id ? result : i)) }))
      }
      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      rendererLog.error('Failed to complete idea from grill:', error)
      set({ error: msg })
      throw error
    }
  },

  reset: () => set({ ideas: [], isLoading: false, error: null })
}))
