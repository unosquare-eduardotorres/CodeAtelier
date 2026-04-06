import { useState, useEffect } from 'react'
import { Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react'
import type { DecomposedTask, TaskExecutionProgress } from '../../../../shared/types'

interface BuildProgressCardProps {
  tasks: DecomposedTask[]
  taskProgress: Map<string, TaskExecutionProgress>
  isExecuting: boolean
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function StatusIcon({ status }: { status?: string }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={14} className="animate-spin text-amber-400" />
    case 'completed':
      return <CheckCircle2 size={14} className="text-emerald-400" />
    case 'failed':
      return <XCircle size={14} className="text-red-400" />
    default:
      return <Circle size={14} className="text-text-muted" />
  }
}

export default function BuildProgressCard({
  tasks,
  taskProgress,
  isExecuting
}: BuildProgressCardProps): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!isExecuting) return
    const start = Date.now()
    const interval = setInterval(() => {
      setElapsed(Date.now() - start)
    }, 1000)
    return () => clearInterval(interval)
  }, [isExecuting])

  const completedCount = tasks.filter((t) => {
    const p = taskProgress.get(t.id)
    return p?.status === 'completed' || p?.status === 'failed'
  }).length
  const progressPct = tasks.length > 0 ? (completedCount / tasks.length) * 100 : 0

  return (
    <div className="my-3 rounded-xl border border-border-subtle bg-surface-overlay overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-surface-raised">
        <Loader2 size={16} className="animate-spin text-sky-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">Building...</p>
          <p className="text-xs text-text-muted">
            {completedCount} of {tasks.length} tasks completed &middot; {formatElapsed(elapsed)}
          </p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-surface-base">
        <div
          className="h-full bg-sky-500 transition-all duration-500 ease-out"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Task list */}
      <div className="divide-y divide-border-subtle">
        {tasks.map((task) => {
          const progress = taskProgress.get(task.id)
          const status = progress?.status

          return (
            <div key={task.id} className="flex items-center gap-3 px-4 py-2.5">
              <StatusIcon status={status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-text-primary">{task.specialist}</span>
                  {status === 'running' && progress?.currentTool && (
                    <span className="text-[10px] text-text-muted bg-surface-raised px-1.5 py-0.5 rounded">
                      {progress.currentTool}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary truncate">{task.description}</p>
              </div>
              {status === 'completed' && <span className="text-[10px] text-emerald-400">done</span>}
              {status === 'failed' && <span className="text-[10px] text-red-400">failed</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
