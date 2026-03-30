import { useState } from 'react'
import { Users, UserRound, ArrowRight, CheckCircle2, Clock, Loader2, XCircle, X } from 'lucide-react'
import type {
  DecomposedTask,
  ExecutionStrategy,
  TaskExecutionProgress,
  Specialist
} from '../../../../shared/types'
import { useSpecialistStore } from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import { Avatar, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'

interface TaskPlanCardProps {
  summary: string
  tasks: DecomposedTask[]
  mode: 'plan' | 'build'
  taskProgress: Map<string, TaskExecutionProgress>
  isExecuting: boolean
  onExecute: (strategy: ExecutionStrategy) => void
  onDismiss?: () => void
}

const STATUS_ICONS: Record<TaskExecutionProgress['status'], React.ReactNode> = {
  pending: <Clock size={14} className="text-text-muted" />,
  running: <Loader2 size={14} className="text-info animate-spin" />,
  completed: <CheckCircle2 size={14} className="text-success" />,
  failed: <XCircle size={14} className="text-danger" />
}

export default function TaskPlanCard({
  summary,
  tasks,
  mode,
  taskProgress,
  isExecuting,
  onExecute,
  onDismiss
}: TaskPlanCardProps): React.JSX.Element {
  const [hoveredStrategy, setHoveredStrategy] = useState<ExecutionStrategy | null>(null)
  const { specialists } = useSpecialistStore()

  const hasUserChosen = isExecuting || taskProgress.size > 0
  const allDone = tasks.every((t) => {
    const p = taskProgress.get(t.id)
    return p?.status === 'completed' || p?.status === 'failed'
  })

  const getSpecialistMeta = (
    agentId: string
  ): { icon: string; color: string; displayName: string } => {
    return getAgentMeta(agentId, specialists)
  }

  // Group tasks by dependency level for visual layout
  const independentTasks = tasks.filter((t) => t.dependsOn.length === 0)
  const dependentTasks = tasks.filter((t) => t.dependsOn.length > 0)
  const sequentialActionLabel = mode === 'plan' ? 'Run Investigation' : 'Execute Sequential'
  const parallelActionLabel = mode === 'plan' ? 'Run Investigation (Team)' : 'Execute Parallel'

  return (
    <div data-testid="task-plan-card" className="my-3 rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-surface-raised">
        <div className="w-8 h-8 rounded-lg bg-primary-muted flex items-center justify-center">
          <span className="text-sm">📋</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">Task Plan</p>
          <p className="text-xs text-text-secondary truncate">{summary}</p>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full ${
            mode === 'build' ? 'bg-mode-build-muted text-mode-build-text' : 'bg-mode-plan-muted text-mode-plan-text'
          }`}
        >
          {mode}
        </span>
        {!hasUserChosen && onDismiss && (
          <button
            onClick={onDismiss}
            className="p-1 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors"
            title="Dismiss plan"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Task list */}
      <div className="px-4 py-3 space-y-2">
        {/* Independent tasks (can run in parallel) */}
        {independentTasks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              Independent tasks {independentTasks.length > 1 ? '(parallelizable)' : ''}
            </p>
            {independentTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                meta={getSpecialistMeta(task.specialist)}
                specialist={specialists.find((s) => s.agentId === task.specialist)}
                progress={taskProgress.get(task.id)}
              />
            ))}
          </div>
        )}

        {/* Dependent tasks */}
        {dependentTasks.length > 0 && (
          <div className="space-y-1.5 mt-2">
            <p className="text-[10px] uppercase tracking-wider text-text-muted font-medium">
              Depends on previous
            </p>
            {dependentTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                meta={getSpecialistMeta(task.specialist)}
                specialist={specialists.find((s) => s.agentId === task.specialist)}
                progress={taskProgress.get(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Action buttons — only shown before execution starts */}
      {!hasUserChosen && (
        <div className="flex items-stretch border-t border-border-subtle">
          <button
            onClick={() => onExecute('sequential')}
            onMouseEnter={() => setHoveredStrategy('sequential')}
            onMouseLeave={() => setHoveredStrategy(null)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors border-r border-border-subtle"
          >
            <UserRound
              size={16}
              className={hoveredStrategy === 'sequential' ? 'text-info' : 'text-text-muted'}
            />
            <div className="text-left">
              <span className="block text-sm">{sequentialActionLabel}</span>
              <span className="block text-[10px] text-text-muted">
                {mode === 'plan' ? 'One specialist investigates at a time' : 'One at a time, more control'}
              </span>
            </div>
          </button>
          <button
            onClick={() => onExecute('parallel')}
            onMouseEnter={() => setHoveredStrategy('parallel')}
            onMouseLeave={() => setHoveredStrategy(null)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-text-secondary hover:bg-surface-overlay hover:text-text-primary transition-colors"
          >
            <Users
              size={16}
              className={hoveredStrategy === 'parallel' ? 'text-success' : 'text-text-muted'}
            />
            <div className="text-left">
              <span className="block text-sm">{parallelActionLabel}</span>
              <span className="block text-[10px] text-text-muted">
                {mode === 'plan' ? 'Multiple specialists investigate together' : 'Faster, agents work together'}
              </span>
            </div>
          </button>
        </div>
      )}

      {/* Execution status footer */}
      {hasUserChosen && !allDone && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-subtle bg-info-muted">
          <Loader2 size={14} className="text-info animate-spin" />
          <span className="text-xs text-info">
            Executing tasks... (
            {tasks.filter((t) => taskProgress.get(t.id)?.status === 'completed').length}/
            {tasks.length} done)
          </span>
        </div>
      )}
      {allDone && taskProgress.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-subtle bg-success-muted">
          <CheckCircle2 size={14} className="text-success" />
          <span className="text-xs text-success">All tasks completed</span>
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  meta,
  specialist,
  progress
}: {
  task: DecomposedTask
  meta: { icon: string; color: string; displayName: string }
  specialist?: Specialist
  progress?: TaskExecutionProgress
}): React.JSX.Element {
  const statusIcon = progress ? STATUS_ICONS[progress.status] : STATUS_ICONS.pending

  return (
    <div className="flex items-start gap-2.5 py-1.5 px-2 rounded-lg bg-surface-raised/40">
      <div className="flex-shrink-0 mt-0.5">
        {specialist?.usePixelForChat && specialist?.pixelSpriteId ? (
          <PixelSpriteAvatar spriteId={specialist.pixelSpriteId} size={20} />
        ) : (
          <Avatar
            avatarKey={specialist?.avatarUrl ?? getDefaultAvatarForRole(task.specialist)}
            size="sm"
            accentColor={meta.color}
          />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium" style={{ color: meta.color }}>
            {meta.displayName}
          </span>
          <span className="text-[10px] text-text-muted">{task.id}</span>
          {task.dependsOn.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-text-muted">
              <ArrowRight size={10} />
              {task.dependsOn.join(', ')}
            </span>
          )}
        </div>
        <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{task.description}</p>
        {progress?.error && <p className="text-xs text-danger mt-0.5">{progress.error}</p>}
      </div>
      <div className="flex-shrink-0 mt-0.5">{statusIcon}</div>
    </div>
  )
}
