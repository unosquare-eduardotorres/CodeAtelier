import { create } from 'zustand'
import type { Workspace } from '../../../shared/types'

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  isLoading: boolean
  orchestratorStatus: 'stopped' | 'starting' | 'running' | 'error'

  loadWorkspaces: () => Promise<void>
  createWorkspace: (name: string, repoPath: string) => Promise<void>
  openWorkspace: (id: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  clearActiveWorkspace: () => void
  setOrchestratorReady: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspace: null,
  isLoading: false,
  orchestratorStatus: 'stopped',

  loadWorkspaces: async () => {
    set({ isLoading: true })
    try {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces, isLoading: false })

      // Auto-open last used workspace if none is active
      const { activeWorkspace } = get()
      if (!activeWorkspace && workspaces.length > 0) {
        get().openWorkspace(workspaces[0].id)
      }
    } catch (error) {
      console.error('Failed to load workspaces:', error)
      set({ isLoading: false })
    }
  },

  createWorkspace: async (name: string, repoPath: string) => {
    const workspace = await window.api.createWorkspace({ name, repoPath })
    set((state) => ({ workspaces: [workspace, ...state.workspaces] }))
  },

  openWorkspace: async (id: string) => {
    const workspace = await window.api.openWorkspace({ id })
    set({ activeWorkspace: workspace })
    // Refresh workspace list to update lastOpenedAt (without auto-open to prevent recursion)
    try {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces })
    } catch { /* silently ignore refresh failure */ }
    // Fire-and-forget: start orchestrator (don't block on readiness)
    set({ orchestratorStatus: 'starting' })
    window.api.startOrchestrator(workspace.repoPath).catch((error) => {
      console.error('Failed to start orchestrator:', error)
      set({ orchestratorStatus: 'error' })
    })
  },

  deleteWorkspace: async (id: string) => {
    await window.api.deleteWorkspace({ id })
    const { activeWorkspace } = get()
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspace: activeWorkspace?.id === id ? null : activeWorkspace
    }))
  },

  clearActiveWorkspace: () => {
    set({ activeWorkspace: null, orchestratorStatus: 'stopped' })
  },

  setOrchestratorReady: () => set({ orchestratorStatus: 'running' })
}))
