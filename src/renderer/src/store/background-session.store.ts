/**
 * Background session store — tracks status of all workspace sessions and
 * pending permission requests for the multi-workspace concurrent sessions feature.
 *
 * This store is always active regardless of which workspace is currently visible.
 * It receives status updates from ALL workspaces via IPC listeners mounted in
 * AppLayout, and feeds data to WorkspaceStatusIndicator and NotificationStack.
 */

import { create } from 'zustand'
import type { AgentStatus, PendingPermission } from '../../../shared/types'

interface BackgroundSessionState {
  /** Status of each workspace's session, keyed by workspaceId. */
  statuses: Record<string, AgentStatus>

  /** Permission requests pending user action. */
  pendingPermissions: PendingPermission[]

  // ── Actions ──

  /** Update or set the status for a workspace. */
  updateStatus: (workspaceId: string, status: AgentStatus) => void

  /** Add a pending permission request. */
  addPermission: (permission: PendingPermission) => void

  /** Remove a permission by ID (resolved or dismissed). */
  removePermission: (id: string) => void

  /** Mark a permission as having fallen back to badge display (toast dismissed/timed out). */
  markBadgeFallback: (id: string) => void
}

// Preserve Zustand state across HMR (dev only)
const previousState = import.meta.hot?.data?.backgroundSessionStoreState as
  Partial<BackgroundSessionState> | undefined

export const useBackgroundSessionStore = create<BackgroundSessionState>((set, _get) => ({
  statuses: previousState?.statuses ?? {},
  pendingPermissions: previousState?.pendingPermissions ?? [],

  updateStatus: (workspaceId, status) =>
    set((s) => ({
      statuses: { ...s.statuses, [workspaceId]: { ...status, workspaceId } }
    })),

  addPermission: (permission) =>
    set((s) => ({
      pendingPermissions: [...s.pendingPermissions, permission]
    })),

  removePermission: (id) =>
    set((s) => ({
      pendingPermissions: s.pendingPermissions.filter((p) => p.id !== id)
    })),

  markBadgeFallback: (id) =>
    set((s) => ({
      pendingPermissions: s.pendingPermissions.map((p) =>
        p.id === id ? { ...p, badgeFallback: true } : p
      )
    }))
}))

// Preserve state on HMR dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    import.meta.hot!.data.backgroundSessionStoreState = useBackgroundSessionStore.getState()
  })
}
