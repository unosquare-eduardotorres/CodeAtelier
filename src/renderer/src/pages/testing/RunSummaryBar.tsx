/**
 * RunSummaryBar — At-a-glance metrics for the selected run.
 *
 * Structured 2-tier layout:
 *   Row 1: pass-rate hero + counts + duration | model chip + status badge
 *   Row 2 (conditional): regression delta + baseline picker
 */

import { CheckCircle2, XCircle, AlertTriangle, Ban, Clock, Cpu, ChevronDown } from 'lucide-react'
import type { E2ERunSummary } from '../../../../shared/types'

interface RunSummaryBarProps {
  run: E2ERunSummary
  /** Regression delta vs baseline run — computed by parent */
  delta: { fixed: number; regressed: number } | null
  /** All runs for baseline picker */
  runs: E2ERunSummary[]
  selectedRunId: string | null
  /** Currently selected baseline run ID (null = previous run) */
  baselineRunId: string | null
  /** Callback when baseline selection changes */
  onBaselineChange: (runId: string | null) => void
}

function relativeLabel(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  if (diffMs < 0) return 'just now'
  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function RunSummaryBar({ run, delta, runs, selectedRunId, baselineRunId, onBaselineChange }: RunSummaryBarProps): React.JSX.Element {
  const total = run.totalPassed + run.totalFailed + run.totalSkipped + run.totalError
  const passRate = total > 0 ? Math.round((run.totalPassed / total) * 100) : 0

  // Duration
  const durationStr = (() => {
    if (!run.finishedAt || !run.startedAt) return null
    const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
    if (ms < 0) return null
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
    const mins = Math.floor(ms / 60_000)
    const secs = Math.round((ms % 60_000) / 1000)
    return `${mins}m ${secs}s`
  })()

  const showComparison = runs.length > 1
  const hasDelta = delta && (delta.fixed > 0 || delta.regressed > 0)

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-overlay">
      {/* Row 1: metrics + badges */}
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left group: pass-rate hero + counts + duration */}
        <div className="flex items-center gap-4">
          {/* Pass rate — large number */}
          <div className="flex items-baseline gap-1.5">
            <span
              className={`text-2xl font-bold tabular-nums ${
                passRate === 100
                  ? 'text-success'
                  : passRate >= 50
                    ? 'text-text-body'
                    : 'text-danger'
              }`}
            >
              {passRate}%
            </span>
            <span className="text-xs text-text-muted">pass rate</span>
          </div>

          {/* Vertical divider */}
          <div className="border-l border-border-subtle h-6" />

          {/* Counts */}
          <div className="flex items-center gap-3 text-xs">
            <span className="flex items-center gap-1 text-success">
              <CheckCircle2 size={12} /> {run.totalPassed}
            </span>
            <span className="flex items-center gap-1 text-danger">
              <XCircle size={12} /> {run.totalFailed}
            </span>
            {run.totalError > 0 && (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle size={12} /> {run.totalError}
              </span>
            )}
            {run.totalSkipped > 0 && (
              <span className="flex items-center gap-1 text-text-muted">
                <Ban size={12} /> {run.totalSkipped}
              </span>
            )}
          </div>

          {/* Duration */}
          {durationStr && (
            <>
              <div className="border-l border-border-subtle h-6" />
              <span className="flex items-center gap-1 text-xs text-text-muted">
                <Clock size={12} /> {durationStr}
              </span>
            </>
          )}
        </div>

        {/* Right group: model chip + status badge — never wraps alone */}
        <div className="flex items-center gap-2 shrink-0">
          {run.modelId && (
            <span className="flex items-center gap-1 text-xs text-text-secondary px-1.5 py-0.5 rounded-lg bg-surface-base">
              <Cpu size={10} /> {run.modelId}
            </span>
          )}
          <span
            className={`text-xs px-1.5 py-0.5 rounded-lg ${
              run.status === 'running'
                ? 'bg-info/20 text-info'
                : run.status === 'completed'
                  ? 'bg-surface-base text-text-muted'
                  : 'bg-warning/20 text-warning'
            }`}
          >
            {run.status}
          </span>
        </div>
      </div>

      {/* Row 2: comparison strip (only when multiple runs exist) */}
      {showComparison && (hasDelta || true) && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border-subtle">
          {/* Regression delta */}
          <div className="text-xs text-text-muted">
            {hasDelta ? (
              <span>
                {delta!.fixed > 0 && (
                  <span className="text-success mr-2">+{delta!.fixed} fixed</span>
                )}
                {delta!.regressed > 0 && (
                  <span className="text-danger">{delta!.regressed} regressed</span>
                )}
              </span>
            ) : (
              <span className="text-text-muted/60">No changes vs baseline</span>
            )}
          </div>

          {/* Baseline picker dropdown */}
          <span className="relative inline-flex items-center">
            <span className="text-xs text-text-muted/60 mr-1">vs</span>
            <select
              value={baselineRunId ?? ''}
              onChange={(e) => onBaselineChange(e.target.value || null)}
              className="appearance-none bg-surface-base border border-border-subtle rounded-lg pl-2 pr-5 py-0.5 text-xs text-text-secondary cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary-muted"
            >
              <option value="">previous run</option>
              {runs
                .filter((r) => r.id !== selectedRunId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {relativeLabel(r.startedAt)} — {Math.round(
                      ((r.totalPassed) / Math.max(r.totalPassed + r.totalFailed + r.totalSkipped + r.totalError, 1)) * 100
                    )}%
                  </option>
                ))}
            </select>
            <ChevronDown size={10} className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none text-text-muted" />
          </span>
        </div>
      )}
    </div>
  )
}
