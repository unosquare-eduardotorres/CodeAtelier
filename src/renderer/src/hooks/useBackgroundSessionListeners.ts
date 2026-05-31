/**
 * useBackgroundSessionListeners — mounts IPC listeners for multi-workspace
 * session events. Runs at the AppLayout level so status updates from ALL
 * workspaces are captured regardless of which workspace is currently visible.
 *
 * Feeds data into useBackgroundSessionStore.
 */

import { useEffect, useRef } from 'react'
import { useBackgroundSessionStore } from '@renderer/store'
import type { AgentStatus, PendingPermission } from '../../../shared/types'

export function useBackgroundSessionListeners(): void {
  const updateStatus = useBackgroundSessionStore((s) => s.updateStatus)
  const addPermission = useBackgroundSessionStore((s) => s.addPermission)
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

  // Listen for permission requests from background workspaces
  useEffect(() => {
    const unsub = window.api.onPermissionRequest((data) => {
      addPermission(data as unknown as PendingPermission)
    })
    return unsub
  }, [addPermission])

  // Fetch initial statuses on mount
  useEffect(() => {
    window.api
      .getAllWorkspaceStatuses()
      .then((statuses) => {
        for (const [wsId, status] of Object.entries(statuses)) {
          updateStatus(wsId, status as AgentStatus)
        }
      })
      .catch(() => {
        // Non-fatal — statuses will be populated by events
      })
  }, [updateStatus])

  // Badge fallback timer: after 10 seconds, collapse toast to badge
  useEffect(() => {
    const timers = timersRef.current

    for (const p of pendingPermissions) {
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
