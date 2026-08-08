/**
 * NotificationStack — manages the toast stack for permission requests and
 * completion notifications from background workspace sessions.
 *
 * Renders in the top-right corner of the app. Shows at most 3 visible toasts
 * with an overflow counter. Only shows toasts for NON-active workspaces
 * (active workspace permissions are handled inline).
 *
 * Mounted at the AppLayout level so it's always visible.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useBackgroundSessionStore, useWorkspaceStore } from '@renderer/store'
import PermissionApprovalModal from './PermissionApprovalModal'
import CompletionToast from './CompletionToast'
import type { CompletionNotification, PendingPermission } from '../../../../shared/types'

const MAX_VISIBLE_TOASTS = 3

/** Maps a notification targetPage to AppLayout navigation state. */
const PAGE_NAV_MAP: Record<string, { sidebarView: 'chat' | 'settings'; settingsTab?: string }> = {
  chat: { sidebarView: 'chat' },
  grill: { sidebarView: 'settings', settingsTab: 'ideas' },
  audit: { sidebarView: 'settings', settingsTab: 'health' },
  mpa: { sidebarView: 'settings', settingsTab: 'goals' },
  council: { sidebarView: 'settings', settingsTab: 'council' },
  blueprints: { sidebarView: 'settings', settingsTab: 'blueprints' },
  memory: { sidebarView: 'settings', settingsTab: 'memory' }
}

export interface NotificationStackProps {
  /** Navigate to a specific page/tab after switching workspaces. */
  onNavigateToPage?: (sidebarView: 'chat' | 'settings', settingsTab?: string) => void
}

export default function NotificationStack({
  onNavigateToPage
}: NotificationStackProps): React.JSX.Element | null {
  const permissions = useBackgroundSessionStore((s) => s.pendingPermissions)
  const removePermission = useBackgroundSessionStore((s) => s.removePermission)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspace?.id)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  // Completion notifications (auto-dismiss after 8 seconds)
  const [completions, setCompletions] = useState<(CompletionNotification & { id: string })[]>([])
  const dismissTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Clear all pending auto-dismiss timers on unmount
  useEffect(
    () => () => {
      dismissTimersRef.current.forEach(clearTimeout)
    },
    []
  )

  // Listen for OS notification click → navigate to workspace + target page
  useEffect(() => {
    const unsub = window.api.onNotificationNavigate((data) => {
      openWorkspace(data.workspaceId)
      const nav = PAGE_NAV_MAP[data.targetPage]
      if (nav && onNavigateToPage) {
        onNavigateToPage(nav.sidebarView, nav.settingsTab)
      }
    })
    return unsub
  }, [openWorkspace, onNavigateToPage])

  // Listen for completion notifications
  useEffect(() => {
    const unsub = window.api.onCompletionNotification((data) => {
      const notification = data as CompletionNotification
      // Skip silent chat completions (show all other services, all failures, all needs_input)
      if (notification.service === 'chat' && notification.status === 'completed') return
      // Skip notifications for the active workspace
      if (notification.workspaceId === activeWorkspaceId) return

      const id = `completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setCompletions((prev) => [...prev, { ...notification, id }])

      // Auto-dismiss after 8 seconds
      const timerId = setTimeout(() => {
        setCompletions((prev) => prev.filter((c) => c.id !== id))
        dismissTimersRef.current.delete(timerId)
      }, 8000)
      dismissTimersRef.current.add(timerId)
    })
    return unsub
  }, [activeWorkspaceId])

  // Show toasts for NON-active workspaces, plus toolPermission for the active
  // workspace. The toolPermission exception is NOT a double surface: a request
  // for the conversation on screen never reaches this store at all —
  // useBackgroundSessionListeners routes it to the inline transcript card. What
  // the exception still catches is the active workspace's OTHER conversations,
  // which have no transcript on screen to render a card into.
  const visiblePermissions = permissions.filter(
    (p) => (p.workspaceId !== activeWorkspaceId || p.type === 'toolPermission') && !p.badgeFallback
  )

  const handlePermissionRespond = useCallback(
    (permission: PendingPermission, response: 'approve' | 'deny') => {
      window.api
        .respondToPermission({
          permissionId: permission.id,
          workspaceId: permission.workspaceId,
          type: permission.type,
          response,
          // For toolPermission, include the original payload so the IPC handler
          // can extract the requestId to route back to the control-actions server.
          ...(permission.type === 'toolPermission' ? { payload: permission.payload } : {})
        })
        .catch(console.error)
      removePermission(permission.id)
    },
    [removePermission]
  )

  const handlePermissionView = useCallback(
    (permission: PendingPermission) => {
      // Switch to the workspace that needs attention
      openWorkspace(permission.workspaceId)
      removePermission(permission.id)
    },
    [openWorkspace, removePermission]
  )

  const handlePermissionDismiss = useCallback(
    (permission: PendingPermission) => {
      // Always send explicit deny on dismiss — prevents the control-actions
      // server from waiting for a response that never comes (stale chat bug).
      window.api
        .respondToPermission({
          permissionId: permission.id,
          workspaceId: permission.workspaceId,
          type: permission.type,
          response: 'deny',
          ...(permission.type === 'toolPermission' ? { payload: permission.payload } : {})
        })
        .catch(console.error)
      removePermission(permission.id)
    },
    [removePermission]
  )

  const handleCompletionView = useCallback(
    (notification: CompletionNotification & { id: string }) => {
      openWorkspace(notification.workspaceId)
      const targetPage = notification.targetPage ?? notification.service
      const nav = PAGE_NAV_MAP[targetPage]
      if (nav && onNavigateToPage) {
        onNavigateToPage(nav.sidebarView, nav.settingsTab)
      }
      setCompletions((prev) => prev.filter((c) => c.id !== notification.id))
    },
    [openWorkspace, onNavigateToPage]
  )

  const handleCompletionDismiss = useCallback((id: string) => {
    setCompletions((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const totalVisible = visiblePermissions.length + completions.length
  if (totalVisible === 0) return null

  return (
    <div data-testid="notification-stack" className="fixed top-14 right-4 z-50 flex flex-col gap-3">
      {/* Permission modal — shows one at a time (oldest first, queue model) */}
      {visiblePermissions.length > 0 && (
        <PermissionApprovalModal
          permission={visiblePermissions[0]}
          queueCount={visiblePermissions.length}
          onRespond={(response) => handlePermissionRespond(visiblePermissions[0], response)}
          onView={() => handlePermissionView(visiblePermissions[0])}
          onDismiss={() => handlePermissionDismiss(visiblePermissions[0])}
        />
      )}

      {/* Completion toasts — fill remaining slots */}
      {completions
        .slice(0, Math.max(0, MAX_VISIBLE_TOASTS - visiblePermissions.length))
        .map((c) => (
          <CompletionToast
            key={c.id}
            notification={c}
            onView={() => handleCompletionView(c)}
            onDismiss={() => handleCompletionDismiss(c.id)}
          />
        ))}

      {/* Overflow counter */}
      {totalVisible > MAX_VISIBLE_TOASTS && (
        <div className="text-xs text-text-muted text-center py-1">
          +{totalVisible - MAX_VISIBLE_TOASTS} more pending
        </div>
      )}
    </div>
  )
}
