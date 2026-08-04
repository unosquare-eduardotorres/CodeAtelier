/**
 * TaskSummaryBadge — compact unified status badge replacing PlanProgressBar,
 * TaskExecutionBar, and TodoTaskBar.
 *
 * Collapsed by default — a single line showing phase + task + todo counts.
 * The chevron button toggles the ChatExecutionPanel side panel.
 * Clicking the bar text expands a 2-3 line inline summary of current work.
 *
 * Only visible when there is active execution data or todos.
 */

import { useState, useEffect, useCallback } from 'react'
import { Zap, Layers, ChevronDown, CheckCircle2, Circle, XCircle } from 'lucide-react'
import {
  usePlanExecutionStore,
  type PlanExecution
} from '@renderer/store/plan-execution.store'
import { useTodoStore, type TodoItem } from '@renderer/store/todo.store'
import { statusDotColor } from './plan-status-icons'

const EMPTY_TODOS: TodoItem[] = []

interface TaskSummaryBadgeProps {
  conversationId: string
  panelOpen: boolean
  onTogglePanel: () => void
}

export default function TaskSummaryBadge({
  conversationId,
  panelOpen,
  onTogglePanel
}: TaskSummaryBadgeProps): React.JSX.Element | null {
  const selectExecution = useCallback(
    (s: { executions: Record<string, PlanExecution> }) => s.executions[conversationId],
    [conversationId]
  )
  const execution = usePlanExecutionStore(selectExecution)
  const todos = useTodoStore((s) => s.todos[conversationId] ?? EMPTY_TODOS)

  const [inlineExpanded, setInlineExpanded] = useState(false)

  // Phase stats
  const completedPhases = execution?.phases.filter((p) => p.status === 'completed').length ?? 0
  const totalPhases = execution?.totalPhases ?? 0
  const allPhasesDone = totalPhases > 0 && completedPhases === totalPhases

  // Task stats (flatten all tasks across phases)
  const allTasks = execution?.phases.flatMap((p) => p.tasks) ?? []
  const completedTasks = allTasks.filter(
    (t) => t.status === 'complete' || t.status === 'skipped'
  ).length
  const totalTasks = allTasks.length
  const currentTask = allTasks.find((t) => t.status === 'running')

  // Current phase
  const currentPhase = execution?.phases.find(
    (p) => p.status === 'started' || p.status === 'in_progress'
  )

  // Todo stats
  const completedTodos = todos.filter((t) => t.completed).length
  const totalTodos = todos.length

  // All complete?
  const allComplete = allPhasesDone && (totalTasks === 0 || completedTasks === totalTasks)

  // Auto-collapse inline detail when everything completes
  useEffect(() => {
    if (allComplete && inlineExpanded) {
      const timer = setTimeout(() => setInlineExpanded(false), 3000)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [allComplete, inlineExpanded])

  // Nothing to show — hide badge entirely
  const hasExecution = execution && execution.phases.length > 0
  const hasTodos = totalTodos > 0
  if (!hasExecution && !hasTodos) return null

  // Completed execution — compact read-only indicator with panel toggle
  if (execution?.completedAt) {
    const failedPhases = execution.phases.filter((p) => p.status === 'failed').length
    const allFailed =
      execution.phases.length > 0 && execution.phases.every((p) => p.status === 'failed')
    return (
      <div data-testid="task-summary-badge" className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden">
        <div className="flex items-center w-full px-4 py-2 text-sm">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {allFailed ? (
              <XCircle size={14} className="text-error flex-shrink-0" />
            ) : (
              <CheckCircle2 size={14} className="text-success flex-shrink-0" />
            )}
            <span className="font-medium text-text-body">Plan complete</span>
            <span className="tabular-nums text-text-secondary">
              {completedPhases}/{totalPhases} phases
            </span>
            {failedPhases > 0 && (
              <span className="text-error text-xs">({failedPhases} failed)</span>
            )}
          </div>
          <button
            data-testid="task-summary-badge-toggle"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? 'Close tasks panel' : 'Open tasks panel'}
            onClick={onTogglePanel}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              panelOpen
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/80'
            }`}
            title={panelOpen ? 'Close tasks panel' : 'Open tasks panel'}
          >
            <Layers size={14} />
            Review
          </button>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="task-summary-badge" className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden">
      {/* Compact single-line header */}
      <div className="flex items-center w-full px-4 py-2 text-sm">
        {/* Left: clickable status text — expands inline detail */}
        <button
          aria-expanded={inlineExpanded}
          aria-label="Toggle task details"
          onClick={() => setInlineExpanded(!inlineExpanded)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left transition-colors hover:bg-surface-overlay/40 -ml-1 pl-1 rounded"
        >
          <Zap size={14} className={allComplete ? 'text-success flex-shrink-0' : 'text-accent flex-shrink-0'} />
          {hasExecution && (
            <>
              <span className="font-medium text-text-body">
                {allComplete ? 'Complete' : 'Building:'}
              </span>
              <span className="tabular-nums text-text-secondary">
                Phase {completedPhases}/{totalPhases}
              </span>
              {totalTasks > 0 && (
                <span className="tabular-nums text-text-secondary">
                  · Tasks {completedTasks}/{totalTasks}
                </span>
              )}
            </>
          )}
          {hasTodos && (
            <span className="tabular-nums text-text-secondary">
              {hasExecution ? '· ' : ''}Todos {completedTodos}/{totalTodos}
            </span>
          )}
          {allComplete && (
            <span className="text-success text-xs font-medium ml-1">✓</span>
          )}
          <ChevronDown
            size={12}
            className={`text-text-muted transition-transform duration-200 flex-shrink-0 ${inlineExpanded ? 'rotate-180' : ''}`}
          />
        </button>

        {/* Right: progress dots + panel toggle */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          {/* Progress dots */}
          {hasExecution && (
            <span className="flex gap-1">
              {execution.phases.map((p) => (
                <span
                  key={p.phaseId}
                  className={`w-2 h-2 rounded-full ${statusDotColor(p.status)}`}
                />
              ))}
            </span>
          )}

          {/* Panel toggle button */}
          <button
            data-testid="task-summary-badge-toggle"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? 'Close tasks panel' : 'Open tasks panel'}
            onClick={onTogglePanel}
            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
              panelOpen
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay/80'
            }`}
            title={panelOpen ? 'Close tasks panel' : 'Open tasks panel'}
          >
            <Layers size={14} />
            {totalTasks > 0 && (
              <span className="tabular-nums">
                {completedTasks}/{totalTasks}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Inline expanded detail — shows current task + next pending */}
      {inlineExpanded && (
        <div className="border-t border-border-subtle px-4 py-2 space-y-1">
          {currentTask && (
            <div className="flex items-center gap-2 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse flex-shrink-0" />
              <span className="text-text-body truncate">
                <span className="text-text-muted">Running:</span> {currentTask.title}
              </span>
            </div>
          )}
          {currentPhase && !currentTask && (
            <div className="flex items-center gap-2 text-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-info animate-pulse flex-shrink-0" />
              <span className="text-text-body truncate">
                <span className="text-text-muted">Phase:</span> {currentPhase.phaseTitle}
              </span>
            </div>
          )}
          {/* Next pending task */}
          {(() => {
            const nextPending = allTasks.find((t) => t.status === 'pending')
            if (!nextPending) return null
            return (
              <div className="flex items-center gap-2 text-sm">
                <Circle size={10} className="text-text-muted flex-shrink-0" />
                <span className="text-text-muted truncate">
                  Next: {nextPending.title}
                </span>
              </div>
            )
          })()}
          {/* Todos summary when no task details */}
          {!hasExecution && hasTodos && (
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2 size={12} className="text-text-muted flex-shrink-0" />
              <span className="text-text-muted">
                {completedTodos} of {totalTodos} todos completed
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
