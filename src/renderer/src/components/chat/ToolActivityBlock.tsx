import { useState } from 'react'
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react'
import type { ToolActivity } from '../../../../shared/types'

interface ToolActivityBlockProps {
  activities: ToolActivity[]
}

export default function ToolActivityBlock({
  activities
}: ToolActivityBlockProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false)

  if (activities.length === 0) return null

  const completedCount = activities.filter((a) => a.status === 'completed').length
  const runningCount = activities.filter((a) => a.status === 'running').length
  const runningActivities = activities.filter((a) => a.status === 'running')

  return (
    <div className="my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <Wrench size={12} />
        <span>
          {runningCount > 0
            ? `${activities.length} tool${activities.length > 1 ? 's' : ''} (${runningCount} running...)`
            : `${completedCount} tool${completedCount > 1 ? 's' : ''} used`}
        </span>
        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>

      {/* Always show running tools even when collapsed */}
      {!isExpanded && runningActivities.length > 0 && (
        <div className="mt-1.5 ml-4 space-y-1 border-l-2 border-border-subtle pl-3">
          {runningActivities.map((activity) => (
            <div key={activity.id} className="flex items-center gap-2 text-xs">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              <span className="font-mono text-text-body">{activity.toolName}</span>
              {activity.input && (
                <span className="text-text-muted truncate max-w-[300px]">{activity.input}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Expanded: show all activities including completed */}
      {isExpanded && (
        <div className="mt-1.5 ml-4 space-y-1 border-l-2 border-border-subtle pl-3">
          {activities.map((activity) => (
            <div key={activity.id} className="flex items-center gap-2 text-xs">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  activity.status === 'running'
                    ? 'bg-yellow-400 animate-pulse'
                    : activity.status === 'completed'
                      ? 'bg-green-400'
                      : 'bg-red-400'
                }`}
              />
              <span className="font-mono text-text-body">{activity.toolName}</span>
              {activity.input && (
                <span className="text-text-muted truncate max-w-[300px]">{activity.input}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
