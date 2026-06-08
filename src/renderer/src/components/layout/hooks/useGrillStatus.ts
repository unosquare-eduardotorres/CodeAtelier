/**
 * useGrillStatus — subscribes to grill session status changes.
 */
import { useState, useEffect } from 'react'

export interface GrillStatusInfo {
  status: string
  ideaId: string
  trackId: string | null
  score: number | null
}

export function useGrillStatus(workspaceId: string | undefined): GrillStatusInfo | null {
  const [grillStatus, setGrillStatus] = useState<GrillStatusInfo | null>(null)

  useEffect(() => {
    if (!workspaceId) return

    let cancelled = false
    let gotLiveEvent = false

    // Fetch initial status — but don't clobber a live event that arrived first
    window.api.grillGetStatus({ workspaceId }).then((s) => {
      if (!cancelled && !gotLiveEvent) setGrillStatus(s)
    })

    // Live events always win over the initial fetch
    const unsub = window.api.onGrillStatusChanged((s) => {
      gotLiveEvent = true
      setGrillStatus(s)
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [workspaceId])

  // No workspace → no status (derived, avoids synchronous setState in effect)
  return workspaceId ? grillStatus : null
}
