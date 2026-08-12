import { create } from 'zustand'
import { rendererLog } from '@renderer/utils/logger'
import type { Workspace, RepoInfo } from '../../../shared/types'

/** Lightweight snapshot cached per workspace for fast re-hydration on switch. */
interface WorkspaceSnapshot {
  lastConversationId: string | null
  scrollPosition: number
  agentStatus: 'stopped' | 'starting' | 'running' | 'error'
}

interface WorkspaceState {
  workspaces: Workspace[]
  activeWorkspace: Workspace | null
  isLoading: boolean
  agentStatus: 'stopped' | 'starting' | 'running' | 'error'
  repoInfo: RepoInfo | null
  githubStatus: { configured: boolean; login?: string; tokenType?: string } | null

  /** Cached snapshots for fast workspace re-hydration. */
  snapshots: Record<string, WorkspaceSnapshot>

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
  Partial<WorkspaceState> | undefined

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: previousWorkspaceState?.workspaces ?? [],
  activeWorkspace: previousWorkspaceState?.activeWorkspace ?? null,
  isLoading: previousWorkspaceState?.isLoading ?? false,
  agentStatus: previousWorkspaceState?.agentStatus ?? 'stopped',
  repoInfo: previousWorkspaceState?.repoInfo ?? null,
  githubStatus: previousWorkspaceState?.githubStatus ?? null,
  snapshots: (previousWorkspaceState as WorkspaceState | undefined)?.snapshots ?? {},

  loadWorkspaces: async () => {
    set({ isLoading: true })
    try {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces, isLoading: false })

      // Auto-open last used workspace if none is active
      // STORE-03: Wrap in try-catch to prevent silent error swallowing
      const { activeWorkspace } = get()
      if (!activeWorkspace && workspaces.length > 0) {
        try {
          await get().openWorkspace(workspaces[0].id)
        } catch (err) {
          rendererLog.error('Failed to auto-open workspace:', err)
        }
      }
    } catch (error) {
      rendererLog.error('Failed to load workspaces:', error)
      set({ isLoading: false })
    }
  },

  createWorkspace: async (name: string, repoPath: string) => {
    // STORE-05: Let errors propagate to caller but ensure state consistency
    try {
      const workspace = await window.api.createWorkspace({ name, repoPath })
      set((state) => ({ workspaces: [workspace, ...state.workspaces] }))
    } catch (error) {
      rendererLog.error('Failed to create workspace:', error)
      throw error
    }
  },

  openWorkspace: async (id: string) => {
    const { activeWorkspace: previousWorkspace, agentStatus: prevStatus } = get()

    // Save snapshot of current workspace before switching
    if (previousWorkspace) {
      set((state) => ({
        snapshots: {
          ...state.snapshots,
          [previousWorkspace.id]: {
            lastConversationId: null, // Chat store handles its own state
            scrollPosition: 0,
            agentStatus: prevStatus
          }
        }
      }))
    }

    const workspace = await window.api.openWorkspace({ id })
    set({ activeWorkspace: workspace })

    // Refresh workspace list to update lastOpenedAt (without auto-open to prevent recursion)
    try {
      const workspaces = await window.api.listWorkspaces()
      set({ workspaces })
    } catch {
      /* silently ignore refresh failure */
    }

    // Restore snapshot if available — shows cached status instantly
    const snapshot = get().snapshots[id]
    if (snapshot) {
      set({ agentStatus: snapshot.agentStatus })
    }

    // Fire-and-forget: start agent runtime (don't block on readiness).
    // Multi-workspace: startAgent calls startForWorkspace on the backend
    // which creates a NEW session or re-activates an existing one — does NOT
    // kill sessions for other workspaces.
    if (!snapshot || snapshot.agentStatus !== 'running') {
      set({ agentStatus: 'starting' })
    }
    // STORE-01: Track workspace ID at call time to ignore stale completions
    // from rapid workspace switching (A→B→A)
    const openedId = workspace.id
    window.api
      .startAgent({ workspacePath: workspace.repoPath, workspaceId: workspace.id })
      .catch((error) => {
        if (get().activeWorkspace?.id !== openedId) return // Stale — ignore
        rendererLog.error('Failed to start agent runtime:', error)
        set({ agentStatus: 'error' })
      })

    // Load repo info + GitHub status in parallel (fire-and-forget)
    // STORE-04: Guard against cross-workspace pollution from slow responses
    get().loadRepoInfo(id)
    get().loadGitHubStatus(id)
  },

  deleteWorkspace: async (id: string) => {
    // Backend handles session cleanup via workspace.ipc.ts → stopForWorkspace
    await window.api.deleteWorkspace({ id })
    const { activeWorkspace, snapshots } = get()

    // Remove snapshot for deleted workspace
    const { [id]: _, ...remainingSnapshots } = snapshots

    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.id !== id),
      activeWorkspace: activeWorkspace?.id === id ? null : activeWorkspace,
      snapshots: remainingSnapshots
    }))
  },

  clearActiveWorkspace: () => {
    const { activeWorkspace, agentStatus } = get()

    // Save snapshot before clearing — so we can restore quickly on re-open.
    // Backend sessions are still running, so preserve agentStatus.
    if (activeWorkspace) {
      set((state) => ({
        snapshots: {
          ...state.snapshots,
          [activeWorkspace.id]: {
            lastConversationId: null,
            scrollPosition: 0,
            agentStatus
          }
        }
      }))
    }

    set({ activeWorkspace: null, repoInfo: null, githubStatus: null })
  },

  setAgentReady: () => set({ agentStatus: 'running' }),

  loadRepoInfo: async (workspaceId: string) => {
    try {
      const repoInfo = await window.api.getRepoInfo({ workspaceId })
      // STORE-04: Guard against cross-workspace pollution from slow responses
      if (get().activeWorkspace?.id !== workspaceId) return
      set({ repoInfo })
    } catch {
      if (get().activeWorkspace?.id !== workspaceId) return
      set({ repoInfo: null })
    }
  },

  loadGitHubStatus: async (workspaceId: string) => {
    try {
      const githubStatus = await window.api.getGitHubStatus({ workspaceId })
      // STORE-04: Guard against cross-workspace pollution from slow responses
      if (get().activeWorkspace?.id !== workspaceId) return
      set({ githubStatus })
    } catch {
      if (get().activeWorkspace?.id !== workspaceId) return
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
