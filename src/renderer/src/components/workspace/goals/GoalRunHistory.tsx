import { useMpaStore } from '@renderer/store/mpa.store'
import { RUN_STATUS_CONFIG } from './constants'
import type { MpaRun } from '../../../../../shared/mpa-types'

interface GoalRunHistoryProps {
  onSelectRun?: (runId: string) => void
}

export default function GoalRunHistory({
  onSelectRun
}: GoalRunHistoryProps): JSX.Element {
  const history = useMpaStore((s) => s.history)

  if (history.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="text-xs text-text-muted">No past goals yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium text-text-secondary">Past Goals</h4>
      {history.map((run: MpaRun) => {
        const config = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.running
        const date = new Date(run.createdAt)
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

        return (
          <button
            type="button"
            key={run.id}
            onClick={() => onSelectRun?.(run.id)}
            className="w-full flex items-center gap-3 px-3 py-2 bg-surface-base rounded-lg border border-border-subtle hover:bg-surface-hover transition-colors text-left"
          >
            <span className={config.color}>{config.icon}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary truncate">{run.title}</p>
              <p className="text-[10px] text-text-muted">
                {dateStr} · {run.goalType} · {run.totalTokens > 0 ? `${Math.round(run.totalTokens / 1000)}K tok` : '—'}
              </p>
            </div>
          </button>
        )
      })}
    </div>
  )
}
