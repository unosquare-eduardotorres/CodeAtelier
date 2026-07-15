/**
 * RunHistory — Horizontal timeline strip of past runs.
 *
 * Most recent first (left). Selected card highlighted with primary border.
 * Horizontally scrollable when runs exceed container width.
 */

import { History, CheckCircle2, XCircle, Loader2, RotateCcw, Play, Clock, Ban } from 'lucide-react'
import type { E2ERunSummary } from '../../../../shared/types'
import SectionCard from './SectionCard'

interface RunHistoryProps {
  runs: E2ERunSummary[]
  selectedRunId: string | null
  isRunning: boolean
  preflightOk: boolean
  onSelectRun: (runId: string) => void
  onRequeueFailed: (runId: string) => void
  onResumeRun: (runId: string) => void
  onCancel: () => void
}

// ── Helpers ──

function relativeTime(dateStr: string): string {
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
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function runDuration(run: E2ERunSummary): string | null {
  if (!run.finishedAt || !run.startedAt) return null
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (ms < 0) return null
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.round((ms % 60_000) / 1000)
  return `${mins}m${secs > 0 ? ` ${secs}s` : ''}`
}

// ── Main ──

export default function RunHistory({
  runs,
  selectedRunId,
  isRunning,
  preflightOk,
  onSelectRun,
  onRequeueFailed,
  onResumeRun,
  onCancel
}: RunHistoryProps): React.JSX.Element {
  if (runs.length === 0) {
    return (
      <SectionCard title="Run History" icon={<History size={14} />}>
        <div className="text-center py-4 text-sm text-text-muted">
          No test runs yet. Run some scenarios to see results here.
        </div>
      </SectionCard>
    )
  }

  const cancelButton = isRunning ? (
    <button
      onClick={onCancel}
      className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border border-danger/40 text-danger hover:bg-danger/10 transition-colors"
    >
      Cancel
    </button>
  ) : undefined

  return (
    <SectionCard title="Run History" icon={<History size={14} />} action={cancelButton} flush>
      <div className="flex gap-2 overflow-x-auto px-3 py-2 pb-3">
        {runs.map((run) => {
          const isActive = run.id === selectedRunId
          const total =
            run.totalPassed + run.totalFailed + run.totalSkipped + run.totalError
          const canResume = run.status === 'cancelled' && run.totalError > 0
          // Requeue retries assertion failures always. It also retries scenarios that errored
          // mid-run — but NOT on a cancelled run, where Resume already re-runs the identical
          // error set (prevents a redundant duplicate button).
          const canRequeue = run.totalFailed > 0 || (run.totalError > 0 && !canResume)
          const duration = runDuration(run)

          return (
            <button
              key={run.id}
              type="button"
              onClick={() => onSelectRun(run.id)}
              className={`w-[210px] shrink-0 text-left px-3 py-2 rounded-lg border transition-colors focus:outline-none focus:ring-1 focus:ring-primary-muted ${
                isActive
                  ? 'border-primary-muted bg-primary-muted/10'
                  : 'border-border-subtle hover:bg-surface-raised/50'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  {run.status === 'running' ? (
                    <Loader2 size={14} className="text-info animate-spin shrink-0" />
                  ) : run.status === 'cancelled' ? (
                    <Ban size={14} className="text-text-muted shrink-0" />
                  ) : run.totalFailed > 0 || run.totalError > 0 ? (
                    <XCircle size={14} className="text-danger shrink-0" />
                  ) : (
                    <CheckCircle2 size={14} className="text-success shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs text-text-body"
                        title={new Date(run.startedAt).toLocaleString()}
                      >
                        {relativeTime(run.startedAt)}
                      </span>
                      {duration && (
                        <span className="flex items-center gap-0.5 text-xs text-text-muted tabular-nums">
                          <Clock size={10} /> {duration}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-text-muted tabular-nums">
                      <span className="text-success">{run.totalPassed}✓</span>
                      <span className="text-danger">{run.totalFailed}✗</span>
                      {run.totalError > 0 && (
                        <span className="text-warning">{run.totalError}!</span>
                      )}
                      {run.totalSkipped > 0 && (
                        <span>{run.totalSkipped} skip</span>
                      )}
                      <span className="text-text-muted">/ {total}</span>
                    </div>
                  </div>
                </div>

                {run.status !== 'running' && preflightOk && !isRunning && (
                  <div className="flex items-center gap-1 shrink-0">
                    {canResume && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          onResumeRun(run.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            onResumeRun(run.id)
                          }
                        }}
                        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border border-primary-muted/40 text-primary-muted hover:bg-primary-muted/10 transition-colors"
                        title="Resume incomplete scenarios"
                      >
                        <Play size={10} /> Resume
                      </span>
                    )}
                    {canRequeue && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation()
                          onRequeueFailed(run.id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            onRequeueFailed(run.id)
                          }
                        }}
                        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg border border-border-subtle hover:bg-surface-overlay transition-colors"
                        title="Requeue failed scenarios"
                      >
                        <RotateCcw size={10} /> Requeue
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Mini pass-rate bar */}
              {total > 0 && (
                <div className="h-1 rounded-full bg-surface-base overflow-hidden flex w-full mt-1.5">
                  {run.totalPassed > 0 && (
                    <div className="bg-success" style={{ width: `${(run.totalPassed / total) * 100}%` }} />
                  )}
                  {run.totalFailed > 0 && (
                    <div className="bg-danger" style={{ width: `${(run.totalFailed / total) * 100}%` }} />
                  )}
                  {run.totalError > 0 && (
                    <div className="bg-warning" style={{ width: `${(run.totalError / total) * 100}%` }} />
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </SectionCard>
  )
}
