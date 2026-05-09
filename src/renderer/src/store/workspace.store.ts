import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { Workspace, RepoInfo } from '../../../shared/types'

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  isLoading: boolean
  agentStatus: 'stopped' | 'starting' | 'running' | 'error'
  repoInfo: RepoInfo | null
  githubStatus: { configured: boolean; login?: string; tokenType?: string } | null

  loadWorkspaces: () => Promise<void>
  createWorkspace: (name: string, repoPath: string) => Promise<void>
  openWorkspace: (id: string) => Promise<void>
  deleteWorkspace: (id: string) => Promise<void>
  clearActiveWorkspace: () => void
  setAgentReady: () => void
  loadRepoInfo: (workspaceId: string) => Promise<void>
  loadGitHubStatus: (workspaceId: string) => Promise<void>
}

// Preserve Zustand state across HMR (dev only)
const previousWorkspaceState = import.meta.hot?.data?.workspaceStoreState as
  | Partial<WorkspaceState>
  | undefined

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: previousWorkspaceState?.workspaces ?? [],
  activeWorkspace: previousWorkspaceState?.activeWorkspace ?? null,
  isLoading: previousWorkspaceState?.isLoading ?? false,
  agentStatus: previousWorkspaceState?.agentStatus ?? 'stopped',
  repoInfo: previousWorkspaceState?.repoInfo ?? null,
  githubStatus: previousWorkspaceState?.githubStatus ?? null,

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
      rendererLog.error('Failed to load workspaces:', error)
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
    } catch {
      /* silently ignore refresh failure */
    }
    // Fire-and-forget: start agent runtime (don't block on readiness)
    set({ agentStatus: 'starting' })
    window.api.startAgent(workspace.repoPath).catch((error) => {
      rendererLog.error('Failed to start agent runtime:', error)
      set({ agentStatus: 'error' })
    })
    // Load repo info + GitHub status in parallel (fire-and-forget)
    get().loadRepoInfo(id)
    get().loadGitHubStatus(id)
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
    // Only clear UI state — backend processes are still running, so preserve
    // agentStatus to avoid the "Initializing AI Agent..." overlay on re-open
    set({ activeWorkspace: null, repoInfo: null, githubStatus: null })
  },

  setAgentReady: () => set({ agentStatus: 'running' }),

  loadRepoInfo: async (workspaceId: string) => {
    try {
      const repoInfo = await window.api.getRepoInfo({ workspaceId })
      set({ repoInfo })
    } catch {
      set({ repoInfo: null })
    }
  },

  loadGitHubStatus: async (workspaceId: string) => {
    try {
      const githubStatus = await window.api.getGitHubStatus({ workspaceId })
      set({ githubStatus })
    } catch {
      set({ githubStatus: null })
    }
  }
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.workspaceStoreState = useWorkspaceStore.getState()
  })
}
