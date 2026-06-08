/**
 * HealthRunCard — summary card for a past audit run in the Health landing.
 *
 * Shows the run date, a compact overall score, mode, track count, and status,
 * with Open / Re-run / Delete actions (mirrors CouncilSessionCard).
 */

import { Zap, Microscope, RefreshCw, Trash2, CheckCircle2, AlertTriangle, Ban } from 'lucide-react'
import type { AuditRun } from '../../../../../shared/types'
import ScoreGauge from '../ScoreGauge'

interface HealthRunCardProps {
  run: AuditRun
  onOpen: (run: AuditRun) => void
  onRerun: (run: AuditRun) => void
  onDelete: (runId: string) => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function StatusBadge({ status }: { status: AuditRun['status'] }): React.JSX.Element | null {
  switch (status) {
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-success">
          <CheckCircle2 size={11} /> Completed
        </span>
      )
    case 'partial':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-warning">
          <AlertTriangle size={11} /> Partial
        </span>
      )
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
          <Ban size={11} /> Cancelled
        </span>
      )
    case 'running':
      return <span className="text-[10px] text-info animate-pulse">Running…</span>
    default:
      return <span className="text-[10px] text-text-muted">Pending</span>
  }
}

export default function HealthRunCard({
  run,
  onOpen,
  onRerun,
  onDelete
}: HealthRunCardProps): React.JSX.Element {
  const ModeIcon = run.mode === 'deep' ? Microscope : Zap
  const completedCount = run.results.filter((r) => r.status === 'completed').length

  return (
    <button
      onClick={() => onOpen(run)}
      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border-subtle bg-surface-raised hover:bg-surface-overlay/60 hover:border-border-default transition-all duration-200 text-left group"
    >
      {/* Score */}
      <div className="flex-shrink-0">
        {run.overallScore != null ? (
          <ScoreGauge score={run.overallScore} size={56} label=" " />
        ) : (
          <div className="w-14 h-14 rounded-full border-[5px] border-surface-overlay flex items-center justify-center">
            <span className="text-[10px] text-text-muted font-semibold">N/A</span>
          </div>
        )}
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <ModeIcon size={14} className={run.mode === 'deep' ? 'text-info' : 'text-warning'} />
          <span className="text-sm font-semibold text-text-primary">
            {run.mode === 'deep' ? 'Deep' : 'Light'} Audit
          </span>
          <StatusBadge status={run.status} />
        </div>
        <p className="text-[11px] text-text-muted mt-1">{formatDate(run.createdAt)}</p>
        <p className="text-[11px] text-text-secondary mt-0.5">
          {completedCount}/{run.selectedTracks.length} auditors completed
        </p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onRerun(run)
          }}
          className="p-1.5 rounded-lg text-text-muted hover:text-primary-text hover:bg-surface-overlay transition-colors"
          title="Re-run with the same configuration"
        >
          <RefreshCw size={14} />
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onDelete(run.id)
          }}
          className="p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
          title="Delete this run"
        >
          <Trash2 size={14} />
        </span>
      </div>
    </button>
  )
}
