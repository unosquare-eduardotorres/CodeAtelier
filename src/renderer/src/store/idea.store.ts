import { create } from 'zustand'
import type { Idea, Conversation } from '../../../shared/types'

interface IdeaState {
  ideas: Idea[]
  isLoading: boolean

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

  loadIdeas: async (workspaceId) => {
    set({ isLoading: true })
    try {
      const ideas = await window.api.listIdeas({ workspaceId })
      set({ ideas, isLoading: false })
    } catch (error) {
      console.error('Failed to load ideas:', error)
      set({ isLoading: false })
    }
  },

  createIdea: async (workspaceId, title, description) => {
    const idea = await window.api.createIdea({ workspaceId, title, description })
    set((s) => ({ ideas: [idea, ...s.ideas] }))
    return idea
  },

  updateIdea: async (id, data) => {
    const updated = await window.api.updateIdea({ id, ...data })
    set((s) => ({ ideas: s.ideas.map((i) => (i.id === id ? updated : i)) }))
  },

  deleteIdea: async (id) => {
    await window.api.deleteIdea({ id })
    set((s) => ({ ideas: s.ideas.filter((i) => i.id !== id) }))
  },

  startGrill: async (ideaId, workspaceId) => {
    const result = await window.api.startIdeaGrill({ ideaId, workspaceId })
    set((s) => ({ ideas: s.ideas.map((i) => (i.id === ideaId ? result.idea : i)) }))
    return result
  },

  convertDirect: async (ideaId, workspaceId) => {
    const result = await window.api.convertIdeaDirect({ ideaId, workspaceId })
    set((s) => ({ ideas: s.ideas.map((i) => (i.id === ideaId ? result.idea : i)) }))
    return result
  },

  completeFromGrill: async (conversationId, summary) => {
    const result = await window.api.completeIdeaFromGrill({ conversationId, summary })
    if (result) {
      set((s) => ({ ideas: s.ideas.map((i) => (i.id === result.id ? result : i)) }))
    }
    return result
  },

  reset: () => set({ ideas: [], isLoading: false })
}))
