import { useState, useMemo, type JSX } from 'react'
import { Target, Plus } from 'lucide-react'
import { useMpaStore } from '@renderer/store/mpa.store'
import { RUN_STATUS_CONFIG } from './constants'
import type { MpaRun } from '../../../../../shared/mpa-types'

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' }
] as const

type GoalHistoryFilter = (typeof FILTER_TABS)[number]['value']

interface GoalRunHistoryProps {
  onSelectRun?: (runId: string) => void
  onNewGoal?: () => void
}

export default function GoalRunHistory({
  onSelectRun,
  onNewGoal
}: GoalRunHistoryProps): JSX.Element {
  const history = useMpaStore((s) => s.history)
  const [filter, setFilter] = useState<GoalHistoryFilter>('all')

  const filteredHistory = useMemo(() => {
    if (filter === 'completed') return history.filter((r) => r.status === 'completed')
    if (filter === 'failed')
      return history.filter((r) => r.status === 'failed' || r.status === 'cancelled')
    return history
  }, [history, filter])

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <Target size={32} className="text-cyan-400/30 mb-3" />
        <p className="text-sm text-text-secondary">No past goals yet</p>
        <p className="text-xs text-text-muted mt-1">
          Goals you start will appear here with their status and results.
        </p>
      </div>
    )
  }

  return (
    <div data-testid="goal-run-history" className="space-y-2">
      {/* Filter tabs */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                filter === tab.value
                  ? 'bg-surface-float text-text-primary shadow-sm'
                  : 'text-text-secondary hover:text-text-body'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <h4 className="text-xs font-medium text-text-secondary">Past Goals</h4>
        {onNewGoal && (
          <button
            onClick={onNewGoal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-400 rounded-lg transition-colors ml-auto"
          >
            <Plus size={14} />
            New Goal
          </button>
        )}
      </div>

      {filteredHistory.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <p className="text-sm text-text-secondary">
            {filter === 'completed'
              ? 'No completed goals yet'
              : filter === 'failed'
                ? 'No failed goals'
                : 'No past goals yet'}
          </p>
        </div>
      ) : (
        filteredHistory.map((run: MpaRun) => {
          const config = RUN_STATUS_CONFIG[run.status] ?? RUN_STATUS_CONFIG.running
          const date = new Date(run.createdAt)
          const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

          return (
            <button
              type="button"
              key={run.id}
              onClick={() => onSelectRun?.(run.id)}
              className="group w-full flex items-center gap-3 p-4 bg-surface-overlay rounded-lg border border-border-subtle hover:border-border-default transition-colors shadow-sm text-left"
            >
              <span className={config.color}>{config.icon}</span>
              <div className="flex-1 min-w-0">
                <p
                  className="text-base font-normal text-text-primary truncate"
                  style={{ fontFamily: 'var(--ca-font-display)', letterSpacing: '0.01em' }}
                >
                  {run.title}
                </p>
                <p className="text-[10px] text-text-muted">
                  {dateStr} · {run.goalType} ·{' '}
                  {run.totalTokens > 0 ? `${Math.round(run.totalTokens / 1000)}K tok` : '—'}
                  {(run.status === 'failed' || run.status === 'cancelled') && (
                    <span className="ml-1 text-amber-400">· resumable</span>
                  )}
                </p>
              </div>
            </button>
          )
        })
      )}
    </div>
  )
}
