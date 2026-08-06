/**
 * LastRunSummary — "Last fed 2h ago · 412 items · 1,203 memories · 3 failed".
 *
 * A persistent record of the last ingestion is as useful as live progress: it
 * answers "is my brain current?" without starting anything. When the last run
 * ended early it also offers the resume.
 */

import { Brain, PlayCircle, AlertTriangle } from 'lucide-react'
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
  busy
}: {
  run: BootstrapRunSummary
  resumableRunId: string | null
  onResume: (runId: string) => void
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
          {run.itemsFailed > 0 && <span className="text-red-400"> · {run.itemsFailed} failed</span>}
        </div>
        <div className="text-[10px] text-text-muted mt-0.5">
          {STATUS_LABEL[run.status] ?? run.status} ·{' '}
          {run.mode === 'deep-scan' ? 'Deep Scan' : 'Feed Brain'} · scope: {run.scope}
          {run.error && (
            <span className="text-red-400/80">
              {' '}
              <AlertTriangle className="w-3 h-3 inline" /> {run.error}
            </span>
          )}
        </div>
      </div>

      {canResume && (
        <button
          onClick={() => onResume(resumableRunId)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs bg-teal/10 text-teal rounded hover:bg-teal/20 shrink-0"
          title="Continue from where the last run stopped — nothing already extracted is redone"
        >
          <PlayCircle className="w-3.5 h-3.5" />
          Resume
        </button>
      )}
    </div>
  )
}
