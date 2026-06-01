/**
 * HealthLanding — top-level Workspace Health page when no audit is active.
 *
 * Mirrors CouncilLanding: loading skeleton → empty state (explainer + "New
 * Audit" CTA) → history list of past runs. Selecting a run opens it read-only;
 * "New Audit" starts the configure flow.
 */

import { useEffect, useState, useCallback } from 'react'
import { ShieldCheck, Plus, Search, Microscope, ListChecks } from 'lucide-react'
import { useWorkspaceStore } from '@renderer/store'
import { ConfirmDialog, Skeleton } from '@renderer/components/common'
import type { AuditRun } from '../../../../../shared/types'
import HealthRunCard from './HealthRunCard'

interface HealthLandingProps {
  onNewAudit: () => void
  onOpenRun: (run: AuditRun) => void
  onRerunRun: (run: AuditRun) => void
}

export default function HealthLanding({
  onNewAudit,
  onOpenRun,
  onRerunRun
}: HealthLandingProps): React.JSX.Element {
  const { activeWorkspace } = useWorkspaceStore()
  const workspaceId = activeWorkspace?.id ?? ''

  const [history, setHistory] = useState<AuditRun[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!workspaceId) return
    window.api
      .auditGetHistory({ workspaceId, limit: 10 })
      .then((runs) => setHistory(runs))
      .finally(() => setIsLoading(false))
  }, [workspaceId])

  // Load history on mount + workspace change
  useEffect(() => {
    if (!workspaceId) return
    setIsLoading(true)
    refresh()
  }, [workspaceId, refresh])

  // Refresh when an audit run completes
  useEffect(() => {
    if (!workspaceId) return
    const cleanup = window.api.onAuditComplete(() => refresh())
    return cleanup
  }, [workspaceId, refresh])

  const handleDelete = useCallback(
    async (runId: string) => {
      try {
        await window.api.auditDeleteRun({ runId })
        setHistory((prev) => prev.filter((r) => r.id !== runId))
      } catch {
        // non-critical
      }
      setDeleteTarget(null)
    },
    []
  )

  // ── Loading skeleton ──
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

  // ── Empty state ──
  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-4">
        <div className="max-w-2xl w-full space-y-6">
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-success/15 mb-2">
              <ShieldCheck size={28} className="text-success" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Workspace Health</h2>
            <p className="text-sm text-text-secondary max-w-md mx-auto">
              Run a panel of specialist auditors across your codebase — database, code, testing,
              architecture, security, docs, and UI/UX — to get a scored health report with
              actionable findings.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
              <div className="flex items-center gap-2">
                <ListChecks size={14} className="text-success" />
                <span className="text-sm font-semibold text-text-primary">Configure</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Pick auditors and a Light or Deep pass.
              </p>
            </div>
            <div className="rounded-xl border border-success/20 bg-success/5 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Microscope size={14} className="text-success" />
                <span className="text-sm font-semibold text-text-primary">Inspect</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Auditors stream their analysis as they review your files.
              </p>
            </div>
            <div className="rounded-xl border border-border-subtle bg-surface-overlay p-4 space-y-2">
              <div className="flex items-center gap-2">
                <Search size={14} className="text-primary-text" />
                <span className="text-sm font-semibold text-text-primary">Act</span>
              </div>
              <p className="text-xs text-text-secondary leading-relaxed">
                Turn findings into a plan you can route to Chat, Grill, Goals, or Council.
              </p>
            </div>
          </div>

          <div className="flex justify-center">
            <button
              onClick={onNewAudit}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-success/20 hover:bg-success/30 text-success rounded-xl transition-colors"
            >
              <Plus size={16} />
              New Audit
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── History list ──
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-bold text-text-primary">Audit History</h2>
          <button
            onClick={onNewAudit}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-success/20 hover:bg-success/30 text-success rounded-lg transition-colors"
          >
            <Plus size={14} />
            New Audit
          </button>
        </div>

        <div className="space-y-2">
          {history.map((run) => (
            <HealthRunCard
              key={run.id}
              run={run}
              onOpen={onOpenRun}
              onRerun={onRerunRun}
              onDelete={(id) => setDeleteTarget(id)}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="Delete Audit Run"
        message="Are you sure you want to delete this audit run? This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteTarget && handleDelete(deleteTarget)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
