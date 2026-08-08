/**
 * useBackgroundSessionListeners — mounts IPC listeners for multi-workspace
 * session events. Runs at the AppLayout level so status updates from ALL
 * workspaces are captured regardless of which workspace is currently visible.
 *
 * Feeds data into useBackgroundSessionStore.
 */

import { useEffect, useRef } from 'react'
import { useBackgroundSessionStore, useChatStore } from '@renderer/store'
import { routePermission } from '@renderer/lib/permission-routing'
import type { AgentStatus, PendingPermission } from '../../../shared/types'

export function useBackgroundSessionListeners(): void {
  const updateStatus = useBackgroundSessionStore((s) => s.updateStatus)
  const addPermission = useBackgroundSessionStore((s) => s.addPermission)
  const removePermission = useBackgroundSessionStore((s) => s.removePermission)
  const markBadgeFallback = useBackgroundSessionStore((s) => s.markBadgeFallback)
  const pendingPermissions = useBackgroundSessionStore((s) => s.pendingPermissions)

  // Track badge fallback timers
  const timersRef = useRef<Record<string, NodeJS.Timeout>>({})

  // Listen for status updates from ALL workspaces
  useEffect(() => {
    const unsub = window.api.onWorkspaceStatusUpdate((data) => {
      if (!data.workspaceId) return
      updateStatus(data.workspaceId, data as unknown as AgentStatus)
    })
    return unsub
  }, [updateStatus])

  // Listen for permission requests from background workspaces.
  // A tool permission for the conversation on screen goes inline into the
  // transcript instead — read via getState() so the subscription is stable.
  useEffect(() => {
    const unsub = window.api.onPermissionRequest((data) => {
      const activeConvId = useChatStore.getState().activeConversation?.id ?? null
      if (routePermission(data, activeConvId) === 'inline') {
        useChatStore.getState().setPendingToolPermission(data as unknown as PendingPermission)
        return
      }
      addPermission(data as unknown as PendingPermission)
    })
    return unsub
  }, [addPermission])

  // A permission can end without a click here: the turn is torn down, the CLI
  // child dies, or a backstop denies it. Clear both surfaces on that signal —
  // otherwise the toast/modal and the inline card stay up for a dead turn.
  useEffect(() => {
    const unsub = window.api.onPermissionResolved((data) => {
      removePermission(data.permissionId)
      useChatStore.getState().resolvePermissionExternally({
        permissionId: data.permissionId,
        conversationId: data.conversationId,
        outcome: data.outcome
      })
    })
    return unsub
  }, [removePermission])

  // Fetch initial statuses on mount
  useEffect(() => {
    window.api
      .getAllWorkspaceStatuses()
      .then((statuses) => {
        for (const [wsId, status] of Object.entries(statuses)) {
          updateStatus(wsId, status as AgentStatus)
        }
      })
      .catch((err) => {
        // Non-fatal — statuses will be populated by events
        console.warn('[useBackgroundSessionListeners] Non-fatal: status fetch failed:', err)
      })
  }, [updateStatus])

  // Badge fallback timer: after 10 seconds, collapse toast to badge
  useEffect(() => {
    const timers = timersRef.current

    for (const p of pendingPermissions) {
      // toolPermission requests need explicit approve/deny — keep the toast
      // visible until the user acts or PERMISSION_RESOLVED clears it. There is
      // no server-side auto-deny to fall back on.
      if (p.type === 'toolPermission') continue
      if (!p.badgeFallback && !timers[p.id]) {
        timers[p.id] = setTimeout(() => {
          markBadgeFallback(p.id)
          delete timers[p.id]
        }, 10_000)
      }
    }

    // Clean up timers for removed permissions
    const activeIds = new Set(pendingPermissions.map((p) => p.id))
    for (const [id, timer] of Object.entries(timers)) {
      if (!activeIds.has(id)) {
        clearTimeout(timer)
        delete timers[id]
      }
    }

    return () => {
      for (const timer of Object.values(timers)) {
        clearTimeout(timer)
      }
    }
  }, [pendingPermissions, markBadgeFallback])
}
