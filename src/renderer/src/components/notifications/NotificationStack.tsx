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

import { useCallback, useEffect, useState } from 'react'
import { useBackgroundSessionStore, useWorkspaceStore } from '@renderer/store'
import PermissionToast from './PermissionToast'
import CompletionToast from './CompletionToast'
import type { CompletionNotification, PendingPermission } from '../../../../shared/types'

const MAX_VISIBLE_TOASTS = 3

export default function NotificationStack(): React.JSX.Element | null {
  const permissions = useBackgroundSessionStore((s) => s.pendingPermissions)
  const removePermission = useBackgroundSessionStore((s) => s.removePermission)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspace?.id)
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace)

  // Completion notifications (auto-dismiss after 8 seconds)
  const [completions, setCompletions] = useState<(CompletionNotification & { id: string })[]>([])

  // Listen for completion notifications
  useEffect(() => {
    const unsub = window.api.onCompletionNotification((data) => {
      const notification = data as CompletionNotification
      // Skip silent chat completions (only show audit, mpa, grill completions + all failures)
      if (notification.service === 'chat' && notification.status === 'completed') return
      // Skip notifications for the active workspace
      if (notification.workspaceId === activeWorkspaceId) return

      const id = `completion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      setCompletions((prev) => [...prev, { ...notification, id }])

      // Auto-dismiss after 8 seconds
      setTimeout(() => {
        setCompletions((prev) => prev.filter((c) => c.id !== id))
      }, 8000)
    })
    return unsub
  }, [activeWorkspaceId])

  // Only show toasts for NON-active workspaces that haven't fallen back to badge
  const visiblePermissions = permissions.filter(
    (p) => p.workspaceId !== activeWorkspaceId && !p.badgeFallback
  )

  const handlePermissionRespond = useCallback(
    (permission: PendingPermission, response: 'approve' | 'deny') => {
      window.api
        .respondToPermission({
          permissionId: permission.id,
          workspaceId: permission.workspaceId,
          type: permission.type,
          response
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
      removePermission(permission.id)
    },
    [removePermission]
  )

  const handleCompletionView = useCallback(
    (notification: CompletionNotification & { id: string }) => {
      openWorkspace(notification.workspaceId)
      setCompletions((prev) => prev.filter((c) => c.id !== notification.id))
    },
    [openWorkspace]
  )

  const handleCompletionDismiss = useCallback((id: string) => {
    setCompletions((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const totalVisible = visiblePermissions.length + completions.length
  if (totalVisible === 0) return null

  return (
    <div className="fixed top-14 right-4 z-50 flex flex-col gap-3">
      {/* Permission toasts — show first (higher priority) */}
      {visiblePermissions.slice(0, MAX_VISIBLE_TOASTS).map((p) => (
        <PermissionToast
          key={p.id}
          permission={p}
          onRespond={(response) => handlePermissionRespond(p, response)}
          onView={() => handlePermissionView(p)}
          onDismiss={() => handlePermissionDismiss(p)}
        />
      ))}

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
