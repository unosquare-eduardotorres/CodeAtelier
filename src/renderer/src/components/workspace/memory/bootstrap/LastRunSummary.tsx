/**
 * LastRunSummary — "Last fed 2h ago · 412 items · 1,203 memories · 3 failed".
 *
 * A persistent record of the last ingestion is as useful as live progress: it
 * answers "is my brain current?" without starting anything. When the last run
 * ended early it also offers the resume.
 */

import { Brain, PlayCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@renderer/components/common/ui'
import type { BootstrapRunSummary } from '../../../../../../shared/types'
import { formatRelative } from './phase-meta'

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  paused: 'Paused',
  cancelled: 'Cancelled',
  failed: 'Failed',
  running: 'Running',
  planning: 'Planning'
}

export default function LastRunSummary({
  run,
  resumableRunId,
  onResume,
  onInspectFailures,
  busy
}: {
  run: BootstrapRunSummary
  resumableRunId: string | null
  onResume: (runId: string) => void
  /** Opens the per-item list filtered to failures. */
  onInspectFailures?: () => void
  busy: boolean
}): React.JSX.Element {
  const settled = run.itemsDone + run.itemsSkipped + run.itemsFailed
  const canResume = resumableRunId !== null && !busy

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-overlay/40 px-3 py-2 flex items-center gap-3">
      <Brain className="w-4 h-4 text-teal shrink-0" />

      <div className="min-w-0 flex-1 text-xs">
        <div className="text-text-secondary">
          Last fed {formatRelative(run.finishedAt ?? run.createdAt)}
          <span className="text-text-muted">
            {' · '}
            {settled}/{run.itemsTotal} items · {run.factsCreated} memories
          </span>
          {run.itemsFailed > 0 &&
            (onInspectFailures ? (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={onInspectFailures}
                  className="text-danger underline underline-offset-2 hover:text-danger/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus rounded"
                >
                  {run.itemsFailed} failed
                </button>
              </>
            ) : (
              <span className="text-danger"> · {run.itemsFailed} failed</span>
            ))}
        </div>
        <div className="text-[11px] text-text-muted mt-0.5">
          {STATUS_LABEL[run.status] ?? run.status} ·{' '}
          {run.mode === 'deep-scan' ? 'Deep Scan' : 'Feed Brain'} · scope: {run.scope}
          {run.error && (
            <span className="text-danger/80">
              {' '}
              <AlertTriangle className="w-3 h-3 inline" /> {run.error}
            </span>
          )}
        </div>
      </div>

      {canResume && (
        <Button
          variant="primary"
          onClick={() => onResume(resumableRunId)}
          className="shrink-0"
          title="Continue from where the last run stopped — nothing already extracted is redone"
        >
          <PlayCircle className="w-3.5 h-3.5" />
          Resume
        </Button>
      )}
    </div>
  )
}
