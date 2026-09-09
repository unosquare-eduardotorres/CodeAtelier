/**
 * DesignLanding — top-level Audit Design page when no run is open.
 *
 * Mirrors HealthLanding: loading skeleton → empty state (explainer + CTA) →
 * history of past design runs.
 */

import { useEffect, useState, useCallback } from 'react'
import { Palette, Plus, Sparkles, ScanSearch, ListChecks } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import type { AuditRun } from '../../../../../shared/types'
import DesignRunCard from './DesignRunCard'

interface DesignLandingProps {
  onNewRun: () => void
  onOpenRun: (run: AuditRun) => void
}

export default function DesignLanding({
  onNewRun,
  onOpenRun
}: DesignLandingProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaceId = activeWorkspace?.id ?? ''

  const [history, setHistory] = useState<AuditRun[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!workspaceId) return
    window.api
      .designGetHistory({ workspaceId })
      .then((res) => setHistory(res.ok ? res.data : []))
      // Refusals arrive inside the envelope; a rejection here means the IPC
      // itself failed, which must still land the page rather than hang it.
      .catch(() => setHistory([]))
      .finally(() => setIsLoading(false))
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional loading state before refresh
    setIsLoading(true)
    refresh()
  }, [workspaceId, refresh])

  // Refresh when a design run completes. The listener is not workspace-filtered
  // here on purpose: `refresh` re-reads this workspace's history regardless, so
  // another workspace finishing is a harmless extra read, not wrong state.
  useEffect(() => {
    if (!workspaceId) return
    return window.api.onDesignComplete(() => refresh())
  }, [workspaceId, refresh])

  const handleDelete = useCallback(async (runId: string) => {
    try {
      const res = await window.api.designDeleteRun({ runId })
      if (res.ok) setHistory((prev) => prev.filter((r) => r.id !== runId))
    } catch {
      // non-critical
    }
    setDeleteTarget(null)
  }, [])

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-surface-raised border border-border-subtle rounded-xl p-4 flex items-center gap-4"
          >
            <Skeleton className="h-14 w-14 rounded-full flex-shrink-0" />
            <div className="flex-1">
              <Skeleton className="h-4 w-40 mb-2" />
              <Skeleton className="h-3 w-64 mb-1.5" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (history.length === 0) {
    return (
      <div
        data-testid="design-landing"
        className="flex flex-col items-center justify-center h-full px-4"
      >
        <div className="max-w-2xl w-full space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-purple-500/15 mb-2">
              <Palette size={28} className="text-purple-400" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Audit Design</h2>
            <p className="text-sm text-text-secondary max-w-md mx-auto">
              Review the interface itself — visual hierarchy, motion, typography, accessibility and
              generic-feeling design — using the Impeccable design engine alongside a deterministic
              anti-pattern scan.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ListChecks size={14} className="text-purple-400" />
                <span className="text-sm font-semibold text-text-primary">Choose</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Pick the design passes that fit your goal, and the files to look at.
              </p>
            </div>
            <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ScanSearch size={14} className="text-purple-400" />
                <span className="text-sm font-semibold text-text-primary">Review</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                A detector scan plus a multi-round agent pass over your UI sources.
              </p>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Sparkles size={14} className="text-primary-text" />
                <span className="text-sm font-semibold text-text-primary">Act</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Read scored findings with the exact files and lines to change.
              </p>
            </div>
          </div>

          <div className="flex justify-center">
            <button
              data-testid="design-start-btn"
              onClick={onNewRun}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded-xl transition-colors"
            >
              <Plus size={16} />
              New Design Audit
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="design-landing" className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-text-primary">Design Review History</h2>
          <button
            data-testid="design-start-btn"
            onClick={onNewRun}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded-lg transition-colors"
          >
            <Plus size={14} />
            New Design Audit
          </button>
        </div>

        <div className="space-y-2">
          {history.map((run) => (
            <DesignRunCard
              key={run.id}
              run={run}
              onOpen={onOpenRun}
              onDelete={(id) => setDeleteTarget(id)}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Design Run"
        message="Are you sure you want to delete this design run? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
