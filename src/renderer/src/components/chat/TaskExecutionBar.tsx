/**
 * TaskExecutionBar — collapsible bar showing task-level progress within plan phases.
 *
 * Sits between PlanProgressBar and TodoTaskBar in the chat panel.
 * Shows individual tasks within each phase with live status tracking.
 *
 * Collapsed: single-line with task counter + current task title + progress dots.
 * Expanded: full task list grouped by phase with status icons.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ListTodo } from 'lucide-react'
import {
  usePlanExecutionStore,
  type PlanExecution,
  type TaskProgress
} from '@renderer/store/plan-execution.store'
import { PHASE_STATUS_ICON, statusDotColor } from './plan-status-icons'

/** Map task status → status icon key used by PHASE_STATUS_ICON */
function taskStatusToPhaseKey(status: TaskProgress['status']): string {
  switch (status) {
    case 'running':
      return 'in_progress'
    case 'complete':
      return 'completed'
    default:
      return status
  }
}

/** Map task status → dot color class */
function taskDotColor(status: TaskProgress['status']): string {
  switch (status) {
    case 'complete':
      return 'bg-success'
    case 'running':
      return 'bg-info animate-pulse'
    case 'failed':
      return 'bg-danger'
    case 'skipped':
      return 'bg-text-muted'
    default:
      return 'bg-border-subtle'
  }
}

interface TaskExecutionBarProps {
  conversationId: string
}

export default function TaskExecutionBar({
  conversationId
}: TaskExecutionBarProps): React.JSX.Element | null {
  const selectExecution = useCallback(
    (s: { executions: Record<string, PlanExecution> }) => s.executions[conversationId],
    [conversationId]
  )
  const execution = usePlanExecutionStore(selectExecution)
  const [expanded, setExpanded] = useState(false)
  const [autoClosed, setAutoClosed] = useState(false)
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false)
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Flatten all tasks across all phases
  const allTasks = execution?.phases.flatMap((p) => p.tasks) ?? []

  // Only show this bar when there are actual tasks to display
  const hasTasks = allTasks.length > 0

  const completedTasks = allTasks.filter(
    (t) => t.status === 'complete' || t.status === 'skipped'
  ).length
  const totalTasks = allTasks.length
  const allDone = hasTasks && completedTasks === totalTasks
  const currentTask = allTasks.find((t) => t.status === 'running')

  // Auto-collapse 2s after all tasks complete (before PlanProgressBar's 3s for staggered effect)
  useEffect(() => {
    if (allDone && !autoClosed) {
      autoCloseTimerRef.current = setTimeout(() => {
        setExpanded(false)
        setAutoClosed(true)
      }, 2000)
    }
    return () => {
      if (autoCloseTimerRef.current) clearTimeout(autoCloseTimerRef.current)
    }
  }, [allDone, autoClosed])

  // Auto-expand when first task starts running
  useEffect(() => {
    if (!hasAutoExpanded && currentTask) {
      setExpanded(true)
      setHasAutoExpanded(true)
    }
  }, [currentTask, hasAutoExpanded])

  if (!execution || !hasTasks) return null

  // Phases that have tasks
  const phasesWithTasks = execution.phases.filter((p) => p.tasks.length > 0)

  const MAX_DOTS = 20
  const visibleDotTasks = allTasks.slice(0, MAX_DOTS)
  const hiddenDotCount = allTasks.length - visibleDotTasks.length

  return (
    <div data-testid="task-execution-bar" className="mx-6 mb-2 rounded-lg border border-border-subtle bg-surface-overlay/60 backdrop-blur-sm overflow-hidden">
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-sm transition-colors hover:bg-surface-overlay/80"
      >
        <span className="flex items-center gap-2">
          <ListTodo size={14} className={allDone ? 'text-success' : 'text-accent'} />
          <span className="font-medium text-text-body">Subtasks:</span>
          <span className="tabular-nums text-text-secondary">
            {completedTasks}/{totalTasks}
          </span>
          {currentTask && (
            <span className="text-text-muted truncate max-w-[220px]">
              — {currentTask.title}
            </span>
          )}
          {allDone && (
            <span className="text-success text-xs font-medium">✓ Complete</span>
          )}
        </span>
        <span className="flex items-center gap-2">
          {/* Progress dots — one per task, capped at MAX_DOTS */}
          <span className="flex items-center gap-0.5">
            {visibleDotTasks.map((t) => (
              <span
                key={t.taskId}
                className={`w-1.5 h-1.5 rounded-full ${taskDotColor(t.status)}`}
              />
            ))}
            {hiddenDotCount > 0 && (
              <span className="text-[10px] text-text-muted ml-0.5">+{hiddenDotCount}</span>
            )}
          </span>
          <ChevronDown
            size={14}
            className={`text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </span>
      </button>

      {/* Expanded task list grouped by phase */}
      {expanded && (
        <div className="border-t border-border-subtle px-2 py-1 max-h-60 overflow-y-auto">
          {phasesWithTasks.map((phase) => (
            <div key={phase.phaseId}>
              {/* Phase header — only show if multiple phases have tasks */}
              {phasesWithTasks.length > 1 && (
                <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-xs font-medium text-text-muted uppercase tracking-wider">
                  <span
                    className={`w-2 h-2 rounded-full ${statusDotColor(phase.status)}`}
                  />
                  {phase.phaseTitle}
                </div>
              )}
              {/* Task list */}
              {phase.tasks.map((task) => (
                <div
                  key={task.taskId}
                  data-testid="task-execution-item"
                  className="flex items-center gap-2 px-2 py-1.5 text-sm"
                >
                  {PHASE_STATUS_ICON[taskStatusToPhaseKey(task.status)] ??
                    PHASE_STATUS_ICON.pending}
                  <span
                    className={
                      task.status === 'complete'
                        ? 'text-text-muted line-through'
                        : task.status === 'running'
                          ? 'text-text-body font-medium'
                          : 'text-text-body'
                    }
                  >
                    {task.title}
                  </span>
                  {task.files && task.files.length > 0 && (
                    <span className="ml-auto text-xs text-text-muted tabular-nums">
                      {task.files.length} file{task.files.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
