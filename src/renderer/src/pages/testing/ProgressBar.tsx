/**
 * ProgressBar — Live run progress with labeled legend and aria attributes.
 *
 * Phase 3c: Legend with labeled counts (passed/failed/queued) instead of
 * color-only segments; role="progressbar" + aria attrs.
 */

interface ProgressBarProps {
  counts: {
    passed: number
    failed: number
    skipped: number
    error: number
    queued: number
    running: number
    total: number
  }
}

export default function ProgressBar({ counts }: ProgressBarProps): React.JSX.Element {
  const { total } = counts
  if (total === 0) return <></>

  const completed = counts.passed + counts.failed + counts.error + counts.skipped
  const pct = Math.round((completed / total) * 100)

  return (
    <div className="space-y-2">
      {/* Progress bar */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-text-muted">
          <span>
            {completed}/{total} completed
          </span>
          <span>{pct}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuenow={completed}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label={`Test progress: ${completed} of ${total} completed (${pct}%)`}
          className="h-2 rounded-full bg-surface-base overflow-hidden flex"
        >
          {counts.passed > 0 && (
            <div
              className="bg-success transition-all duration-300"
              style={{ width: `${(counts.passed / total) * 100}%` }}
            />
          )}
          {counts.failed > 0 && (
            <div
              className="bg-danger transition-all duration-300"
              style={{ width: `${(counts.failed / total) * 100}%` }}
            />
          )}
          {counts.error > 0 && (
            <div
              className="bg-warning transition-all duration-300"
              style={{ width: `${(counts.error / total) * 100}%` }}
            />
          )}
          {counts.skipped > 0 && (
            <div
              className="bg-text-muted/30 transition-all duration-300"
              style={{ width: `${(counts.skipped / total) * 100}%` }}
            />
          )}
          {counts.running > 0 && (
            <div
              className="bg-info animate-pulse transition-all duration-300"
              style={{ width: `${(counts.running / total) * 100}%` }}
            />
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
        {counts.passed > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-success" aria-hidden="true" />
            Passed: <span className="tabular-nums text-text-secondary">{counts.passed}</span>
          </span>
        )}
        {counts.failed > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-danger" aria-hidden="true" />
            Failed: <span className="tabular-nums text-text-secondary">{counts.failed}</span>
          </span>
        )}
        {counts.error > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-warning" aria-hidden="true" />
            Error: <span className="tabular-nums text-text-secondary">{counts.error}</span>
          </span>
        )}
        {counts.running > 0 && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-info" aria-hidden="true" />
            Running: <span className="tabular-nums text-text-secondary">{counts.running}</span>
          </span>
        )}
        {counts.queued > 0 && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full bg-surface-base border border-border-subtle"
              aria-hidden="true"
            />
            Queued: <span className="tabular-nums text-text-secondary">{counts.queued}</span>
          </span>
        )}
        {counts.skipped > 0 && (
          <span className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full bg-text-muted/30"
              aria-hidden="true"
            />
            Skipped: <span className="tabular-nums text-text-secondary">{counts.skipped}</span>
          </span>
        )}
      </div>
    </div>
  )
}
