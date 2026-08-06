import type { JSX } from 'react'
import { CheckCircle, Circle, Loader2, XCircle, Layers } from 'lucide-react'

type TaskStatus = 'pending' | 'running' | 'complete' | 'failed' | 'skipped'

interface BlueprintWaveProgressProps {
  wave: number
  taskCount: number
  waveTasks: Record<string, TaskStatus>
}

function TaskStatusIcon({ status }: { status: TaskStatus }): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={14} className="text-accent animate-spin" />
    case 'complete':
      return <CheckCircle size={14} className="text-success" />
    case 'failed':
      return <XCircle size={14} className="text-danger" />
    default:
      return <Circle size={14} className="text-border-subtle" />
  }
}

function statusLabel(status: TaskStatus): string {
  switch (status) {
    case 'running':
      return 'Running'
    case 'complete':
      return 'Complete'
    case 'failed':
      return 'Failed'
    default:
      return 'Pending'
  }
}

export default function BlueprintWaveProgress({
  wave,
  taskCount,
  waveTasks
}: BlueprintWaveProgressProps): JSX.Element {
  const taskEntries = Object.entries(waveTasks)
  const completedCount = taskEntries.filter(([, s]) => s === 'complete').length
  const failedCount = taskEntries.filter(([, s]) => s === 'failed').length
  const runningCount = taskEntries.filter(([, s]) => s === 'running').length

  // Detect remediation wave — all tasks have R-prefixed IDs
  const isRemediation = taskEntries.length > 0 && taskEntries.every(([id]) => id.startsWith('R'))

  return (
    <div className="space-y-3">
      {/* Wave header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layers size={14} className="text-accent" />
          <span
            className={`text-xs font-semibold ${isRemediation ? 'text-warning' : 'text-text-primary'}`}
          >
            Wave {wave}
            {isRemediation && (
              <span className="text-[10px] font-normal ml-1 text-warning/70">(Remediation)</span>
            )}
          </span>
          <span className="text-[10px] text-text-muted">
            {taskCount} task{taskCount !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[10px]">
          {runningCount > 0 && <span className="text-accent">{runningCount} running</span>}
          {completedCount > 0 && <span className="text-success">{completedCount} done</span>}
          {failedCount > 0 && <span className="text-danger">{failedCount} failed</span>}
        </div>
      </div>

      {/* Progress bar */}
      <div className="w-full h-1.5 bg-surface-base rounded-full overflow-hidden">
        <div
          className="h-full bg-accent rounded-full transition-all duration-300"
          style={{
            width: `${taskCount > 0 ? ((completedCount + failedCount) / taskCount) * 100 : 0}%`
          }}
        />
      </div>

      {/* Task list */}
      {taskEntries.length > 0 && (
        <div className="space-y-1.5">
          {taskEntries.map(([taskId, status]) => (
            <div
              key={taskId}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-surface-base border border-border-subtle"
            >
              <TaskStatusIcon status={status} />
              <span className="text-xs font-mono text-text-secondary flex-1 truncate">
                {taskId}
              </span>
              <span
                className={`text-[10px] font-medium ${
                  status === 'running'
                    ? 'text-accent'
                    : status === 'complete'
                      ? 'text-success'
                      : status === 'failed'
                        ? 'text-danger'
                        : 'text-text-muted'
                }`}
              >
                {statusLabel(status)}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Empty state when wave started but no tasks tracked yet */}
      {taskEntries.length === 0 && (
        <div className="text-xs text-text-muted animate-pulse py-2 text-center">
          Waiting for tasks to start...
        </div>
      )}
    </div>
  )
}
