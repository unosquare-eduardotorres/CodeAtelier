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
    if (!workspaceId) {
      setGrillStatus(null)
      return
    }
    window.api.grillGetStatus({ workspaceId }).then(setGrillStatus)
    const unsub = window.api.onGrillStatusChanged(setGrillStatus)
    return unsub
  }, [workspaceId])

  return grillStatus
}
