import type { JSX } from 'react'
import { Clock, ChevronRight, Trash2 } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { formatTimeAgo, stripMarkdownInline } from './utils'
import type { Blueprint } from '../../../../../shared/blueprint-types'

export default function BlueprintHistoryItem({
  blueprint,
  onSelect,
  onDelete,
  isDeleting
}: {
  blueprint: Blueprint
  onSelect: () => void
  onDelete?: () => void
  isDeleting?: boolean
}): JSX.Element {
  const created = new Date(blueprint.createdAt)
  const timeAgo = formatTimeAgo(created)
  const isTerminal = blueprint.status === 'complete' || blueprint.status === 'failed' || blueprint.status === 'cancelled'
  const completedAgo = blueprint.completedAt ? formatTimeAgo(new Date(blueprint.completedAt)) : null

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      className={`group w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-base border border-border-subtle hover:border-accent/30 hover:bg-surface-hover transition-all text-left cursor-pointer ${
        isDeleting ? 'animate-[bp-item-out_250ms_ease-in_forwards] overflow-hidden' : ''
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">{blueprint.title}</span>
          <StatusBadge status={blueprint.status} />
        </div>
        {blueprint.description && (
          <p className="text-xs text-text-muted mt-0.5 truncate">{stripMarkdownInline(blueprint.description)}</p>
        )}
        <div className="flex items-center gap-2 mt-1">
          <Clock size={10} className="text-text-muted" />
          <span className="text-[10px] text-text-muted" title={isTerminal && blueprint.completedAt ? blueprint.completedAt : blueprint.createdAt}>
            {isTerminal && completedAgo
              ? `${blueprint.status === 'complete' ? 'Completed' : blueprint.status === 'failed' ? 'Failed' : 'Stopped'} ${completedAgo}`
              : timeAgo}
          </span>

        </div>
      </div>
      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-text-muted hover:text-danger hover:bg-danger-muted transition-all flex-shrink-0"
          aria-label={`Delete blueprint "${blueprint.title}"`}
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      )}
      <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
    </div>
  )
}
