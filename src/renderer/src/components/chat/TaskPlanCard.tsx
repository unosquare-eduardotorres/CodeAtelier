import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Users, UserRound, ArrowRight, CheckCircle2, Clock, Loader2, XCircle, X } from 'lucide-react'
import type {
  DecomposedTask,
  ExecutionStrategy,
  InvestigationDepth,
  TaskExecutionProgress,
  Specialist
} from '../../../../shared/types'
import {
  useChatStore,
  useConversationSpecialists,
  useConversationTokenEstimates,
  useSpecialistStore,
  useSpecialistWarningPreferences
} from '@renderer/store'
import { getAgentMeta } from '@renderer/utils/agentMeta'
import { Avatar, PixelSpriteAvatar } from '@renderer/components/common'
import { getDefaultAvatarForRole } from '@renderer/utils/agentIdentity'
import { getSpriteAssignment } from '@renderer/components/pixel-office/agentMapping'
import SpecialistWarningDialog from './SpecialistWarningDialog'
import type { SpecialistWarningType } from './SpecialistWarningDialog'

interface TaskPlanCardProps {
  summary: string
  tasks: DecomposedTask[]
  mode: 'plan' | 'build'
  taskProgress: Map<string, TaskExecutionProgress>
  isExecuting: boolean
  onExecute: (strategy: ExecutionStrategy, depth?: InvestigationDepth) => void
  onDismiss?: () => void
  /** Strategy 13: Pre-selected investigation depth from heuristics (default: 'standard') */
  suggestedDepth?: InvestigationDepth
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
  onDismiss,
  suggestedDepth
}: TaskPlanCardProps): React.JSX.Element {
  const [hoveredStrategy, setHoveredStrategy] = useState<ExecutionStrategy | null>(null)
  // Strategy 13: Use the pre-selected depth from heuristics, defaulting to 'standard'
  const [depth, setDepth] = useState<InvestigationDepth>(suggestedDepth ?? 'standard')
  const [showWarningDialog, setShowWarningDialog] = useState(false)
  const pendingExecuteRef = useRef<{ strategy: ExecutionStrategy; depth?: InvestigationDepth } | null>(null)
  const { specialists } = useSpecialistStore()
  const activeConversation = useChatStore((state) => state.activeConversation)
  const conversationSpecialists = useConversationSpecialists(activeConversation?.id)
  const tokenEstimates = useConversationTokenEstimates(activeConversation?.id)
  const { specialistWarningBuild, specialistWarningPlan, specialistWarningAlways } =
    useSpecialistWarningPreferences()

  const hasUserChosen = isExecuting || taskProgress.size > 0
  const allDone = tasks.every((t) => {
    const p = taskProgress.get(t.id)
    return p?.status === 'completed' || p?.status === 'failed'
  })
  // Exclude core specialists (User, Da Vinci) from the count — they are always active
  // and should not trigger the specialist usage warning dialog
  const coreSpecialistIds = useMemo(
    () => new Set(specialists.filter((s) => s.isCore).map((s) => s.id)),
    [specialists]
  )
  const activeSpecialistCount = conversationSpecialists.filter(
    (specialist) => specialist.isActive && !coreSpecialistIds.has(specialist.specialistId)
  ).length
  const estimatedSpecialistTokens = tokenEstimates.reduce(
    (sum, estimate) => sum + estimate.estimatedTokens,
    0
  )
  const showSpecialistWarningBanner =
    activeSpecialistCount > 0 &&
    (specialistWarningAlways || (mode === 'build' ? specialistWarningBuild : specialistWarningPlan))

  // Strategy 6: Determine whether execution should be gated behind the warning dialog.
  // The dialog only shows when active specialists exist AND the relevant warning preference is enabled.
  const warningType: SpecialistWarningType = mode === 'build' ? 'build' : 'plan'
  const shouldGateExecution =
    activeSpecialistCount > 0 &&
    (specialistWarningAlways || (mode === 'build' ? specialistWarningBuild : specialistWarningPlan))

  const handleExecuteRequest = useCallback(
    (strategy: ExecutionStrategy, requestedDepth?: InvestigationDepth) => {
      if (shouldGateExecution) {
        pendingExecuteRef.current = { strategy, depth: requestedDepth }
        setShowWarningDialog(true)
      } else {
        onExecute(strategy, requestedDepth)
      }
    },
    [shouldGateExecution, onExecute]
  )

  const handleWarningConfirm = useCallback(() => {
    setShowWarningDialog(false)
    if (pendingExecuteRef.current) {
      onExecute(pendingExecuteRef.current.strategy, pendingExecuteRef.current.depth)
      pendingExecuteRef.current = null
    }
  }, [onExecute])

  const handleWarningCancel = useCallback(() => {
    setShowWarningDialog(false)
    pendingExecuteRef.current = null
  }, [])

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

      {showSpecialistWarningBanner && (
        <div className="px-4 py-2 border-b border-border-subtle bg-warning-muted/40">
          <p className="text-xs text-warning flex items-center gap-1.5">
            <span className="font-medium">
              {activeSpecialistCount} active specialist{activeSpecialistCount === 1 ? '' : 's'}
            </span>
            <span className="text-text-secondary">
              This {mode} action can include additional specialist context (~
              {estimatedSpecialistTokens.toLocaleString()} tokens).
            </span>
          </p>
        </div>
      )}

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

      {/* S6: Investigation depth picker — only in plan mode before execution */}
      {mode === 'plan' && !hasUserChosen && (
        <div className="flex items-center gap-2 px-4 py-2 border-t border-border-subtle">
          <span className="text-xs text-text-muted">Depth:</span>
          {(['quick', 'standard', 'deep'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDepth(d)}
              className={`px-2 py-0.5 text-xs rounded-md border transition-colors ${
                depth === d
                  ? 'bg-accent/10 border-accent text-accent'
                  : 'border-border-subtle text-text-muted hover:text-text-primary'
              }`}
            >
              {d === 'quick' ? '⚡ Quick' : d === 'standard' ? '🔍 Standard' : '🔬 Deep'}
            </button>
          ))}
          <span className="text-xs text-text-muted ml-1">
            {depth === 'quick'
              ? '3 turns, 5 tools'
              : depth === 'standard'
                ? '8 turns, 12 tools'
                : '15 turns, 25 tools'}
          </span>
        </div>
      )}

      {/* Action buttons — only shown before execution starts */}
      {!hasUserChosen && (
        <div className="flex items-stretch border-t border-border-subtle">
          <button
            onClick={() => handleExecuteRequest('sequential', depth)}
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
            onClick={() => handleExecuteRequest('parallel', depth)}
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
      {hasUserChosen && !allDone && (() => {
        const completedCount = tasks.filter((t) => taskProgress.get(t.id)?.status === 'completed').length
        const runningTask = tasks.find((t) => taskProgress.get(t.id)?.status === 'running')
        return (
          <div className="px-4 py-2.5 border-t border-border-subtle bg-info-muted">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="text-info animate-spin" />
                <span className="text-xs font-medium text-info">
                  Building... ({completedCount}/{tasks.length} tasks)
                </span>
              </div>
              {runningTask && (
                <span className="text-[10px] text-text-muted">
                  Current: {getSpecialistMeta(runningTask.specialist).displayName}
                </span>
              )}
            </div>
            <div className="h-1 bg-surface-overlay rounded-full overflow-hidden">
              <div
                className="h-full bg-info rounded-full transition-all duration-300"
                style={{ width: `${(completedCount / tasks.length) * 100}%` }}
              />
            </div>
          </div>
        )
      })()}
      {allDone && taskProgress.size > 0 && (() => {
        const failedCount = tasks.filter((t) => taskProgress.get(t.id)?.status === 'failed').length
        const successCount = tasks.length - failedCount
        return (
          <div className="flex items-center gap-2 px-4 py-2 border-t border-border-subtle bg-success-muted">
            <CheckCircle2 size={14} className="text-success" />
            <span className="text-xs text-success">
              All tasks completed — {successCount} succeeded{failedCount > 0 ? `, ${failedCount} failed` : ''}
            </span>
          </div>
        )
      })()}

      {/* Strategy 6: Specialist warning dialog — gates execution when active specialists + warning enabled */}
      <SpecialistWarningDialog
        isOpen={showWarningDialog}
        warningType={warningType}
        activeSpecialistCount={activeSpecialistCount}
        estimatedTokens={estimatedSpecialistTokens > 0 ? estimatedSpecialistTokens : undefined}
        onConfirm={handleWarningConfirm}
        onCancel={handleWarningCancel}
      />
    </div>
  )
}

/** Small component that ticks every second showing live elapsed time */
function ElapsedTimer({ startedAt }: { startedAt: number }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(() => Math.floor((Date.now() - startedAt) / 1000))

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return (): void => clearInterval(interval)
  }, [startedAt])

  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60

  return (
    <span className="text-[10px] text-text-muted tabular-nums">
      {mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}
    </span>
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
        {(specialist?.pixelSpriteId || getSpriteAssignment(task.specialist).pixelSpriteId) ? (
          <PixelSpriteAvatar
            spriteId={specialist?.pixelSpriteId ?? getSpriteAssignment(task.specialist).pixelSpriteId!}
            size={20}
          />
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
        {progress?.status === 'running' && progress.currentTool && (
          <div className="flex items-center gap-1.5 mt-1">
            <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
            <span className="text-[10px] font-mono text-text-muted">
              {progress.currentTool}
            </span>
            {progress.currentToolSummary && (
              <span className="text-[10px] text-text-muted truncate max-w-[250px]">
                {progress.currentToolSummary}
              </span>
            )}
            {(progress.toolCallCount ?? 0) > 0 && (
              <span className="text-[10px] text-text-muted">
                ({progress.toolCallCount} tool calls)
              </span>
            )}
          </div>
        )}
        {progress?.error && <p className="text-xs text-danger mt-0.5">{progress.error}</p>}
      </div>
      <div className="flex-shrink-0 mt-0.5 flex flex-col items-end gap-0.5">
        {statusIcon}
        {progress?.startedAt && (
          progress.completedAt ? (
            <span className="text-[10px] text-text-muted tabular-nums">
              {((progress.completedAt - progress.startedAt) / 1000).toFixed(1)}s
            </span>
          ) : progress.status === 'running' ? (
            <ElapsedTimer startedAt={progress.startedAt} />
          ) : null
        )}
      </div>
    </div>
  )
}
