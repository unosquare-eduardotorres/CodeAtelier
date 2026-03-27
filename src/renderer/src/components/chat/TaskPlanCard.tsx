import { useState } from 'react'
import { Users, UserRound, ArrowRight, CheckCircle2, Clock, Loader2, XCircle, X } from 'lucide-react'
import type {
  DecomposedTask,
  ExecutionStrategy,
  TaskExecutionProgress
} from '../../../../shared/types'
import { AGENT_META } from '../../../../shared/constants'
import { useSpecialistStore } from '@renderer/store'

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
  pending: <Clock size={14} className="text-gray-500" />,
  running: <Loader2 size={14} className="text-blue-400 animate-spin" />,
  completed: <CheckCircle2 size={14} className="text-green-400" />,
  failed: <XCircle size={14} className="text-red-400" />
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
    const dbSpec = specialists.find((s) => s.agentId === agentId)
    if (dbSpec) return { icon: dbSpec.icon, color: dbSpec.color, displayName: dbSpec.displayName }
    return AGENT_META[agentId] ?? { icon: '🔧', color: '#6366F1', displayName: agentId }
  }

  // Group tasks by dependency level for visual layout
  const independentTasks = tasks.filter((t) => t.dependsOn.length === 0)
  const dependentTasks = tasks.filter((t) => t.dependsOn.length > 0)

  return (
    <div className="my-3 rounded-xl border border-gray-700/50 bg-gray-800/60 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-700/50 bg-gray-800/80">
        <div className="w-8 h-8 rounded-lg bg-indigo-600/20 flex items-center justify-center">
          <span className="text-sm">📋</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-200">Task Plan</p>
          <p className="text-xs text-gray-400 truncate">{summary}</p>
        </div>
        <span
          className={`text-[10px] px-2 py-0.5 rounded-full ${
            mode === 'build' ? 'bg-amber-500/20 text-amber-300' : 'bg-purple-500/20 text-purple-300'
          }`}
        >
          {mode}
        </span>
        {!hasUserChosen && onDismiss && (
          <button
            onClick={onDismiss}
            className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 transition-colors"
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
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
              Independent tasks {independentTasks.length > 1 ? '(parallelizable)' : ''}
            </p>
            {independentTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                meta={getSpecialistMeta(task.specialist)}
                progress={taskProgress.get(task.id)}
              />
            ))}
          </div>
        )}

        {/* Dependent tasks */}
        {dependentTasks.length > 0 && (
          <div className="space-y-1.5 mt-2">
            <p className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
              Depends on previous
            </p>
            {dependentTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                meta={getSpecialistMeta(task.specialist)}
                progress={taskProgress.get(task.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Action buttons — only shown before execution starts */}
      {!hasUserChosen && (
        <div className="flex items-stretch border-t border-gray-700/50">
          <button
            onClick={() => onExecute('sequential')}
            onMouseEnter={() => setHoveredStrategy('sequential')}
            onMouseLeave={() => setHoveredStrategy(null)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-gray-300 hover:bg-gray-700/50 hover:text-gray-100 transition-colors border-r border-gray-700/50"
          >
            <UserRound
              size={16}
              className={hoveredStrategy === 'sequential' ? 'text-blue-400' : 'text-gray-500'}
            />
            <div className="text-left">
              <span className="block text-sm">Sequential</span>
              <span className="block text-[10px] text-gray-500">One at a time, more control</span>
            </div>
          </button>
          <button
            onClick={() => onExecute('parallel')}
            onMouseEnter={() => setHoveredStrategy('parallel')}
            onMouseLeave={() => setHoveredStrategy(null)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium text-gray-300 hover:bg-gray-700/50 hover:text-gray-100 transition-colors"
          >
            <Users
              size={16}
              className={hoveredStrategy === 'parallel' ? 'text-green-400' : 'text-gray-500'}
            />
            <div className="text-left">
              <span className="block text-sm">Parallel (Team)</span>
              <span className="block text-[10px] text-gray-500">Faster, agents work together</span>
            </div>
          </button>
        </div>
      )}

      {/* Execution status footer */}
      {hasUserChosen && !allDone && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-700/50 bg-blue-900/10">
          <Loader2 size={14} className="text-blue-400 animate-spin" />
          <span className="text-xs text-blue-300">
            Executing tasks... (
            {tasks.filter((t) => taskProgress.get(t.id)?.status === 'completed').length}/
            {tasks.length} done)
          </span>
        </div>
      )}
      {allDone && taskProgress.size > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-700/50 bg-green-900/10">
          <CheckCircle2 size={14} className="text-green-400" />
          <span className="text-xs text-green-300">All tasks completed</span>
        </div>
      )}
    </div>
  )
}

function TaskRow({
  task,
  meta,
  progress
}: {
  task: DecomposedTask
  meta: { icon: string; color: string; displayName: string }
  progress?: TaskExecutionProgress
}): React.JSX.Element {
  const statusIcon = progress ? STATUS_ICONS[progress.status] : STATUS_ICONS.pending

  return (
    <div className="flex items-start gap-2.5 py-1.5 px-2 rounded-lg bg-gray-800/40">
      <span className="text-sm flex-shrink-0 mt-0.5" role="img" aria-label={meta.displayName}>
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium" style={{ color: meta.color }}>
            {meta.displayName}
          </span>
          <span className="text-[10px] text-gray-600">{task.id}</span>
          {task.dependsOn.length > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-gray-600">
              <ArrowRight size={10} />
              {task.dependsOn.join(', ')}
            </span>
          )}
        </div>
        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{task.description}</p>
        {progress?.error && <p className="text-xs text-red-400 mt-0.5">{progress.error}</p>}
      </div>
      <div className="flex-shrink-0 mt-0.5">{statusIcon}</div>
    </div>
  )
}
