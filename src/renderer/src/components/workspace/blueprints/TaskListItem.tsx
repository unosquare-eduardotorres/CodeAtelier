import type { JSX } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'

// ── Status icon map ──

const TASK_STATUS_ICON: Record<string, JSX.Element> = {
  complete: <CheckCircle2 size={12} className="text-success" />,
  failed: <XCircle size={12} className="text-danger" />
}

const PENDING_ICON = <div className="w-3 h-3 rounded-full border border-border-subtle" />

// ── Task list item ──

interface TaskData {
  id: string
  description: string
  status: string
  wave: number
  filePathsJson: string[]
}

export function TaskListItem({ task }: { task: TaskData }): JSX.Element {
  const icon = TASK_STATUS_ICON[task.status] ?? PENDING_ICON

  return (
    <div
      data-testid={`task-list-item-${task.id}`}
      className="px-3 py-2 rounded-lg bg-surface-base border border-border-subtle"
    >
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-xs text-text-primary flex-1">{task.description}</span>
        <span className="text-[10px] text-text-muted">Wave {task.wave}</span>
      </div>
      {task.filePathsJson.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
          {task.filePathsJson.map((f) => {
            const filename = f.split(/[\\/]/).pop() || f
            return (
              <span
                key={f}
                className="text-[10px] font-mono text-text-muted bg-surface-hover px-1.5 py-0.5 rounded"
                title={f}
              >
                {filename}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
