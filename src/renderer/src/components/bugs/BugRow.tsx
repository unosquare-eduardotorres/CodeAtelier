import type { BugRecord } from '../../../../shared/types'

interface BugRowProps {
  bug: BugRecord
  isSelected: boolean
  isViewing: boolean
  onToggleSelect: (id: string, shiftKey: boolean) => void
  onClick: () => void
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function BugRow({
  bug,
  isSelected,
  isViewing,
  onToggleSelect,
  onClick
}: BugRowProps): React.JSX.Element {
  const sourceLabel = bug.sourceFile
    ? `${bug.sourceFile.split('/').pop()}${bug.sourceLine ? `:${bug.sourceLine}` : ''}`
    : '—'

  return (
    <div
      role="row"
      data-testid={`bug-row-${bug.id}`}
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-2 border-b border-border-subtle cursor-pointer transition-colors ${
        isViewing
          ? 'bg-primary-muted'
          : isSelected
            ? 'bg-surface-overlay'
            : 'hover:bg-surface-overlay'
      }`}
    >
      {/* Checkbox */}
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) =>
          onToggleSelect(
            bug.id,
            e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).shiftKey
          )
        }
        onClick={(e) => e.stopPropagation()}
        className="w-4 h-4 rounded border-border-default accent-primary flex-shrink-0"
      />

      {/* Severity dot */}
      <span
        className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
          bug.severity === 'fatal' ? 'bg-red-500' : 'bg-orange-400'
        }`}
        title={bug.severity}
      />

      {/* Error message + process badge */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span className="text-sm text-text-primary truncate">{bug.errorMessage}</span>
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-base text-text-muted uppercase flex-shrink-0">
          {bug.process}
        </span>
      </div>

      {/* Source file */}
      <span className="text-xs text-text-muted w-[140px] truncate text-right flex-shrink-0 hidden lg:block">
        {sourceLabel}
      </span>

      {/* Occurrences */}
      <span className="text-xs text-text-muted w-[70px] text-right flex-shrink-0 hidden md:block">
        {bug.occurrenceCount > 1 ? `${bug.occurrenceCount}×` : '1×'}
      </span>

      {/* Last seen */}
      <span className="text-xs text-text-muted w-[80px] text-right flex-shrink-0 hidden md:block">
        {formatRelativeTime(bug.lastSeenAt)}
      </span>

      {/* Status badge */}
      <span
        className={`text-[10px] font-medium px-1.5 py-0.5 rounded w-[64px] text-center flex-shrink-0 ${
          bug.isResolved ? 'bg-emerald-500/10 text-emerald-400' : 'bg-orange-500/10 text-orange-400'
        }`}
      >
        {bug.isResolved ? 'Resolved' : 'Open'}
      </span>
    </div>
  )
}
