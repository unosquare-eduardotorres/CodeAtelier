/**
 * useBlueprintStatusBar — tracks blueprint pipeline status across ALL workspaces
 * for the StatusBar indicator + dropdown. Lightweight, independent of the main
 * blueprint store (which is scoped to the focused run).
 *
 * PARALLEL-RUNS: entries are keyed by blueprintId (not workspaceId) — several
 * blueprints may run in ONE workspace. Subscribes to onBlueprintStateSync
 * (push) and seeds from blueprintGetRunningSnapshots (pull) on mount.
 */

import { useState, useEffect, useRef, useMemo } from 'react'
import { useWorkspaceStore } from '@renderer/store'
import type { BlueprintMachineState } from '../../../../../shared/blueprint-snapshot-types'

// ── Types ───────────────────────────────────────────────────────────────────

export interface BlueprintStatusEntry {
  /** Key — one entry per running blueprint (not per workspace). */
  blueprintId: string
  workspaceId: string
  workspaceName: string
  running: boolean
  currentPhase: string | null
  /** Blueprint title (from snapshot) — primary line in the dropdown. */
  blueprintTitle: string | null
  machineState: string
}

export interface BlueprintStatusBarInfo {
  /** Status for the currently active workspace (null if idle) */
  active: BlueprintStatusEntry | null
  /** Count of OTHER running blueprints (any workspace, incl. siblings) */
  backgroundCount: number
  /** All running entries except the active workspace's focused one (for the dropdown) */
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
    /** Apply one snapshot to the keyed map (shared by push + seed paths). */
    const applySnapshot = (snap: {
      blueprintId: string | null
      workspaceId: string
      blueprintTitle?: string | null
      currentPhase: string | null
      running: boolean
      machineState: string
    }): void => {
      const wsName = workspaceNameMap.current.get(snap.workspaceId) ?? 'Unknown'
      const running = isSnapshotRunning(snap)

      setStatuses((prev) => {
        const next = new Map(prev)
        if (running && snap.blueprintId) {
          next.set(snap.blueprintId, {
            blueprintId: snap.blueprintId,
            workspaceId: snap.workspaceId,
            workspaceName: wsName,
            running: true,
            currentPhase: snap.currentPhase,
            blueprintTitle: snap.blueprintTitle ?? null,
            machineState: snap.machineState
          })
        } else if (snap.blueprintId) {
          next.delete(snap.blueprintId)
        }
        return next
      })
    }

    // Subscribe to ALL blueprint state sync events (no workspace filter)
    const unsub = window.api.onBlueprintStateSync((snap) => applySnapshot(snap))

    // Seed: pull ALL running snapshots in one call (parallel runs — replaces
    // the N-per-workspace seeding pull).
    if (typeof window.api.blueprintGetRunningSnapshots === 'function') {
      window.api
        .blueprintGetRunningSnapshots()
        .then((snaps) => {
          for (const snap of snaps) applySnapshot(snap)
        })
        .catch(() => {
          /* ignore seed failure */
        })
    }

    return unsub
  }, [workspaces])

  // Derive active vs background
  const activeId = activeWorkspace?.id ?? null

  return useMemo(() => {
    const all = Array.from(statuses.values())
    // Active entry: a run in the active workspace (first one wins when several
    // run in the same workspace — the dropdown lists the rest).
    const activeEntry = activeId ? (all.find((e) => e.workspaceId === activeId) ?? null) : null
    const backgroundEntries = activeEntry
      ? all.filter((e) => e.blueprintId !== activeEntry.blueprintId)
      : all
    return { active: activeEntry, backgroundCount: backgroundEntries.length, backgroundEntries }
  }, [statuses, activeId])
}
