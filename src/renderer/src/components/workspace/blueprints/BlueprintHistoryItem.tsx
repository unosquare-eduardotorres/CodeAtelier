import type { JSX } from 'react'
import { Clock, ChevronRight } from 'lucide-react'
import { StatusBadge } from './StatusBadge'
import { formatTimeAgo, stripMarkdownInline } from './utils'
import type { Blueprint } from '../../../../../shared/blueprint-types'

export default function BlueprintHistoryItem({
  blueprint,
  onSelect
}: {
  blueprint: Blueprint
  onSelect: () => void
}): JSX.Element {
  const created = new Date(blueprint.createdAt)
  const timeAgo = formatTimeAgo(created)

  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-surface-base border border-border-subtle hover:border-accent/30 hover:bg-surface-hover transition-colors text-left"
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
          <span className="text-[10px] text-text-muted">{timeAgo}</span>
          <span className="text-[10px] text-text-muted">·</span>
          <span className="text-[10px] text-text-muted capitalize">{blueprint.priority}</span>
        </div>
      </div>
      <ChevronRight size={14} className="text-text-muted flex-shrink-0" />
    </button>
  )
}
