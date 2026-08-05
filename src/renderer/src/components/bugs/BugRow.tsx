import { Monitor, Layout, Plug, RefreshCw } from 'lucide-react'
import type { BugRecord } from '../../../../shared/types'
import { parseDbTimestamp } from '../../../../shared/db-time'

interface BugRowProps {
  bug: BugRecord
  isSelected: boolean
  isViewing: boolean
  onToggleSelect: (id: string, shiftKey: boolean) => void
  onClick: () => void
}

const PROCESS_ICON = {
  main: Monitor,
  renderer: Layout,
  preload: Plug
} as const

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - parseDbTimestamp(isoString).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getOccurrenceStyle(count: number): string {
  if (count >= 20) return 'text-danger font-bold'
  if (count >= 6) return 'text-warning font-medium'
  if (count >= 2) return 'text-text-secondary'
  return ''
}

export default function BugRow({
  bug,
  isSelected,
  isViewing,
  onToggleSelect,
  onClick
}: BugRowProps): React.JSX.Element {
  const ProcessIcon = PROCESS_ICON[bug.process] ?? Monitor

  return (
    <div
      role="row"
      data-testid={`bug-row-${bug.id}`}
      onClick={onClick}
      className={`
        flex items-start gap-2 px-3 py-2.5
        border-b border-border-subtle cursor-pointer transition-colors
        border-l-2 ${bug.severity === 'fatal' ? 'border-l-red-500' : 'border-l-orange-400'}
        ${isViewing ? 'bg-primary-muted' : isSelected ? 'bg-surface-overlay' : 'hover:bg-surface-overlay'}
        ${bug.isResolved ? 'opacity-50' : ''}
      `}
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
        className="w-4 h-4 mt-0.5 rounded border-border-default accent-primary flex-shrink-0"
      />

      {/* Content — two lines */}
      <div className="flex-1 min-w-0">
        {/* Line 1: severity dot + error message */}
        <div className="flex items-center gap-1.5">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              bug.severity === 'fatal' ? 'bg-red-500' : 'bg-orange-400'
            }`}
          />
          <span className="text-sm text-text-primary truncate">{bug.errorMessage}</span>
        </div>

        {/* Line 2: process icon + metadata */}
        <div className="flex items-center gap-2 mt-1 text-[11px] text-text-muted">
          {/* Process icon + badge */}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-base uppercase font-medium">
            <ProcessIcon size={9} /> {bug.process}
          </span>

          {/* Source (only if present) */}
          {bug.sourceFile && (
            <>
              <span>·</span>
              <span className="truncate max-w-[140px] font-mono">
                {bug.sourceFile.split('/').pop()}
                {bug.sourceLine ? `:${bug.sourceLine}` : ''}
              </span>
            </>
          )}

          {/* Occurrence count with visual weight */}
          <span>·</span>
          <span
            className={`inline-flex items-center gap-0.5 ${getOccurrenceStyle(bug.occurrenceCount)}`}
          >
            {bug.occurrenceCount >= 6 && <RefreshCw size={9} />}
            {bug.occurrenceCount}×
          </span>

          {/* Relative time */}
          <span>·</span>
          <span>{formatRelativeTime(bug.lastSeenAt)}</span>

          {/* Status badge — neutral for open, green for resolved */}
          <span
            className={`ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium ${
              bug.isResolved
                ? 'bg-success/10 text-success'
                : 'bg-surface-base text-text-muted'
            }`}
          >
            {bug.isResolved ? 'Resolved' : 'Open'}
          </span>
        </div>
      </div>
    </div>
  )
}
