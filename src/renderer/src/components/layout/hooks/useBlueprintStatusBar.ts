/**
 * useBlueprintStatusBar — tracks blueprint pipeline status across ALL workspaces
 * for the StatusBar indicator + dropdown. Lightweight, independent of the main
 * blueprint store (which is scoped to the active workspace).
 *
 * Subscribes to onBlueprintStateSync (push) and seeds from blueprintGetSnapshot
 * (pull) for each known workspace on mount.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import type { BlueprintMachineState } from '../../../../../shared/blueprint-snapshot-types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlueprintStatusEntry {
  workspaceId: string
  workspaceName: string
  running: boolean
  currentPhase: string | null
  blueprintId: string | null
  machineState: string
}

export interface BlueprintStatusBarInfo {
  /** Status for the currently active workspace (null if idle) */
  active: BlueprintStatusEntry | null
  /** Count of OTHER workspaces with running blueprints */
  backgroundCount: number
  /** All running entries except the active workspace (for the dropdown) */
  backgroundEntries: BlueprintStatusEntry[]
}

// ── States considered idle/terminal ─────────────────────────────────────────

const IDLE_OR_TERMINAL: BlueprintMachineState[] = ['idle', 'failed', 'cancelled']

function isSnapshotRunning(snap: { running: boolean; machineState: string }): boolean {
  return (
    snap.machineState === 'phase-running' ||
    (snap.running && !IDLE_OR_TERMINAL.includes(snap.machineState as BlueprintMachineState))
  )
}

// ── Hook ────────────────────────────────────────────────────────────────────

export function useBlueprintStatusBar(): BlueprintStatusBarInfo {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [statuses, setStatuses] = useState<Map<string, BlueprintStatusEntry>>(new Map())
  const workspaceNameMap = useRef<Map<string, string>>(new Map())

  // Keep workspace name map in sync
  useEffect(() => {
    const map = new Map<string, string>()
    for (const ws of workspaces) {
      map.set(ws.id, ws.name)
    }
    workspaceNameMap.current = map
  }, [workspaces])

  useEffect(() => {
    // Subscribe to ALL blueprint state sync events (no workspace filter)
    const unsub = window.api.onBlueprintStateSync((snap) => {
      const wsName = workspaceNameMap.current.get(snap.workspaceId) ?? 'Unknown'
      const running = isSnapshotRunning(snap)

      setStatuses((prev) => {
        const next = new Map(prev)
        if (running) {
          next.set(snap.workspaceId, {
            workspaceId: snap.workspaceId,
            workspaceName: wsName,
            running: true,
            currentPhase: snap.currentPhase,
            blueprintId: snap.blueprintId,
            machineState: snap.machineState
          })
        } else {
          next.delete(snap.workspaceId)
        }
        return next
      })
    })

    // Seed: pull snapshot for each known workspace
    for (const ws of workspaces) {
      if (typeof window.api.blueprintGetSnapshot === 'function') {
        window.api
          .blueprintGetSnapshot({ workspaceId: ws.id })
          .then((snap) => {
            if (!snap) return
            if (isSnapshotRunning(snap)) {
              setStatuses((prev) => {
                const next = new Map(prev)
                next.set(ws.id, {
                  workspaceId: ws.id,
                  workspaceName: ws.name,
                  running: true,
                  currentPhase: snap.currentPhase,
                  blueprintId: snap.blueprintId,
                  machineState: snap.machineState as string
                })
                return next
              })
            }
          })
          .catch(() => {
            /* ignore seed failure */
          })
      }
    }

    return unsub
  }, [workspaces])

  // Derive active vs background
  const activeId = activeWorkspace?.id ?? null

  return useMemo(() => {
    const activeEntry = activeId ? (statuses.get(activeId) ?? null) : null
    const backgroundEntries = Array.from(statuses.values()).filter(
      (e) => e.workspaceId !== activeId
    )
    return { active: activeEntry, backgroundCount: backgroundEntries.length, backgroundEntries }
  }, [statuses, activeId])
}
