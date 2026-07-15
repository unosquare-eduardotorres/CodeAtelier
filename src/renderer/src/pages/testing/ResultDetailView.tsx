/**
 * ResultDetailView — Full-page drill-in for viewing result details.
 *
 * Replaces ResultDetailDrawer. No overlay, no fixed positioning —
 * renders inline and uses the page's own scroll context so transcripts
 * and assertions get the full window width.
 */

import { ArrowLeft, CheckCircle2, XCircle, AlertTriangle, Loader2, Clock } from 'lucide-react'
import type { E2EResultStatus } from '../../../../shared/types'
import ResultDetailPanel from './ResultDetailPanel'

// ── Shared target type ──

export interface DetailTarget {
  resultId: string
  title: string
  status?: E2EResultStatus
  durationMs?: number | null
  from: 'scenarios' | 'runs'
}

// ── Helpers ──

function statusIcon(status: E2EResultStatus | undefined): React.JSX.Element | null {
  switch (status) {
    case 'passed':
      return <CheckCircle2 size={16} className="text-success shrink-0" />
    case 'failed':
      return <XCircle size={16} className="text-danger shrink-0" />
    case 'error':
      return <AlertTriangle size={16} className="text-warning shrink-0" />
    case 'running':
      return <Loader2 size={16} className="text-info animate-spin shrink-0" />
    default:
      return null
  }
}

function statusBadgeClass(status: E2EResultStatus | undefined): string {
  switch (status) {
    case 'passed':
      return 'bg-success/20 text-success'
    case 'failed':
      return 'bg-danger/20 text-danger'
    case 'error':
      return 'bg-warning/20 text-warning'
    case 'running':
      return 'bg-info/20 text-info'
    default:
      return 'bg-surface-base text-text-muted'
  }
}

// ── Props ──

interface ResultDetailViewProps {
  target: DetailTarget
  onBack: () => void
}

// ── Component ──

export default function ResultDetailView({
  target,
  onBack
}: ResultDetailViewProps): React.JSX.Element {
  const backLabel = target.from === 'runs' ? 'Back to Runs' : 'Back to Scenarios'

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-border-subtle text-text-secondary hover:text-text-body hover:bg-surface-raised transition-colors"
        >
          <ArrowLeft size={14} />
          {backLabel}
        </button>

        <div className="flex items-center gap-2.5 min-w-0">
          {statusIcon(target.status)}
          <h2 className="text-sm font-semibold text-text-body truncate">{target.title}</h2>
          {target.status && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded-lg shrink-0 ${statusBadgeClass(target.status)}`}
            >
              {target.status}
            </span>
          )}
          {target.durationMs != null && target.durationMs > 0 && (
            <span className="flex items-center gap-1 text-xs text-text-muted tabular-nums shrink-0">
              <Clock size={10} />
              {(target.durationMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      </div>

      {/* Detail content — full width, page scroll */}
      <ResultDetailPanel resultId={target.resultId} scenarioTitle={target.title} />
    </div>
  )
}
