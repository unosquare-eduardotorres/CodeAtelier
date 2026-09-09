/**
 * DesignRunCard — summary card for a past design run in the Design landing.
 *
 * Mirrors HealthRunCard, but a design run has no Light/Deep axis: what
 * distinguishes two runs is the *commands* the user picked and the brief they
 * wrote, so those take the place of the mode badge.
 */

import { Palette, Trash2, CheckCircle2, AlertTriangle, Ban } from 'lucide-react'
import { DESIGN_COMMANDS_BY_ID } from '../../../../../shared/design-commands'
import type { AuditRun } from '../../../../../shared/types'
import ScoreGauge from '../ScoreGauge'

interface DesignRunCardProps {
  run: AuditRun
  onOpen: (run: AuditRun) => void
  onDelete: (runId: string) => void
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function StatusBadge({ status }: { status: AuditRun['status'] }): React.JSX.Element {
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

export default function DesignRunCard({
  run,
  onOpen,
  onDelete
}: DesignRunCardProps): React.JSX.Element {
  const commandIds = run.designConfig?.commandIds ?? []
  const commandNames = commandIds.map((id) => DESIGN_COMMANDS_BY_ID[id]?.name ?? id)
  const brief = run.designConfig?.brief ?? ''
  const scopeLabel =
    run.designConfig?.scope.mode === 'paths'
      ? run.designConfig.scope.paths.join(', ')
      : 'Whole project'

  return (
    <button
      data-testid="design-run-card"
      onClick={() => onOpen(run)}
      className="w-full flex items-center gap-4 p-4 rounded-xl border border-border-subtle bg-surface-raised hover:bg-surface-overlay/60 hover:border-border-default transition-all duration-200 text-left group"
    >
      <div className="flex-shrink-0">
        {run.overallScore != null ? (
          <ScoreGauge score={run.overallScore} size={56} label=" " />
        ) : (
          <div className="w-14 h-14 rounded-full border-[5px] border-surface-overlay flex items-center justify-center">
            <span className="text-[10px] text-text-muted font-semibold">N/A</span>
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Palette size={14} className="text-purple-400" />
          <span className="text-sm font-semibold text-text-primary truncate">
            {commandNames.length > 0 ? commandNames.join(' + ') : 'Design Review'}
          </span>
          <StatusBadge status={run.status} />
        </div>
        {brief && <p className="text-[11px] text-text-secondary mt-1 truncate italic">“{brief}”</p>}
        <p className="text-[11px] text-text-muted mt-0.5 truncate">
          {formatDate(run.createdAt)} · {scopeLabel}
        </p>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
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
