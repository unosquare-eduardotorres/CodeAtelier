/**
 * useBootstrapStatusBar — tracks Feed Brain ingestion across ALL workspaces for
 * the StatusBar indicator + dropdown.
 *
 * Reads from `memory.store`'s `bootstrapByWorkspace` map, which is fed by a
 * module-level progress subscription rather than a page-scoped one — that is
 * what makes a run started in one workspace visible while you work in another.
 * Seeds from `memoryBootstrapSnapshot` per known workspace on mount so a run
 * that was already in flight (or left paused by a crash) shows up immediately.
 */

import { useEffect, useMemo, useState } from 'react'
import { useMemoryStore, useWorkspaceStore } from '@renderer/store'
import type { BootstrapProgress } from '../../../../../shared/types'

export interface BootstrapStatusEntry {
  workspaceId: string
  workspaceName: string
  jobStatus: BootstrapProgress['jobStatus']
  percent: number
  itemsDone: number
  itemsTotal: number
  factsCreated: number
  runId: string
}

export interface BootstrapStatusBarInfo {
  /** Ingestion state for the active workspace (null when idle) */
  active: BootstrapStatusEntry | null
  /** Count of OTHER workspaces currently ingesting or paused */
  backgroundCount: number
  backgroundEntries: BootstrapStatusEntry[]
}

/** Statuses worth surfacing in the status bar. */
const VISIBLE: BootstrapProgress['jobStatus'][] = ['planning', 'running', 'paused', 'error']

function toEntry(p: BootstrapProgress, workspaceName: string): BootstrapStatusEntry {
  const settled = p.itemsDone + p.itemsSkipped + p.itemsFailed
  return {
    workspaceId: p.workspaceId,
    workspaceName,
    jobStatus: p.jobStatus,
    percent: p.itemsTotal > 0 ? Math.min(100, Math.round((settled / p.itemsTotal) * 100)) : 0,
    itemsDone: settled,
    itemsTotal: p.itemsTotal,
    factsCreated: p.factsCreated,
    runId: p.runId
  }
}

export function useBootstrapStatusBar(): BootstrapStatusBarInfo {
  const activeWorkspace = useWorkspaceStore((s) => s.activeWorkspace)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const byWorkspace = useMemoryStore((s) => s.bootstrapByWorkspace)
  const [seeded, setSeeded] = useState<Record<string, BootstrapProgress>>({})

  // Seed: pull a snapshot per known workspace so runs that started before this
  // component mounted (or before the app restarted) are still represented.
  useEffect(() => {
    let cancelled = false
    if (typeof window.api?.memoryBootstrapSnapshot !== 'function') return undefined

    for (const ws of workspaces) {
      window.api
        .memoryBootstrapSnapshot({ workspaceId: ws.id })
        .then((snap) => {
          if (cancelled || !snap?.progress) return
          setSeeded((prev) => ({ ...prev, [ws.id]: snap.progress as BootstrapProgress }))
        })
        .catch(() => {
          /* ignore seed failure */
        })
    }

    return () => {
      cancelled = true
    }
  }, [workspaces])

  const activeId = activeWorkspace?.id ?? null

  return useMemo(() => {
    const names = new Map(workspaces.map((w) => [w.id, w.name]))
    // Live events win over the seed.
    const merged: Record<string, BootstrapProgress> = { ...seeded, ...byWorkspace }

    const entries: BootstrapStatusEntry[] = Object.values(merged)
      .filter((p) => VISIBLE.includes(p.jobStatus))
      .map((p) => toEntry(p, names.get(p.workspaceId) ?? 'Unknown'))

    const active = entries.find((e) => e.workspaceId === activeId) ?? null
    const backgroundEntries = entries.filter((e) => e.workspaceId !== activeId)

    return { active, backgroundCount: backgroundEntries.length, backgroundEntries }
  }, [byWorkspace, seeded, workspaces, activeId])
}
