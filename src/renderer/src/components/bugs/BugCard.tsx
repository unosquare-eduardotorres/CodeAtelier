import { RefreshCw } from 'lucide-react'
import type { BugRecord } from '../../../../shared/types'

interface BugCardProps {
  bug: BugRecord
  isSelected: boolean
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

export default function BugCard({ bug, isSelected, onClick }: BugCardProps): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-colors ${
        isSelected
          ? 'bg-primary-muted border-primary/30'
          : 'bg-surface-overlay border-border-subtle hover:border-border-default'
      }`}
    >
      <div className="flex items-start gap-2">
        {/* Severity indicator */}
        <span
          className={`mt-1 w-2.5 h-2.5 rounded-full flex-shrink-0 ${
            bug.severity === 'fatal' ? 'bg-red-500' : 'bg-orange-400'
          }`}
          title={bug.severity}
        />

        <div className="flex-1 min-w-0">
          {/* Error message */}
          <p className="text-sm text-text-primary font-medium truncate">{bug.errorMessage}</p>

          {/* Metadata row */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            {/* Process badge */}
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-base text-text-muted uppercase">
              {bug.process}
            </span>

            {/* Occurrence count */}
            {bug.occurrenceCount > 1 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-base text-text-muted">
                <RefreshCw size={9} /> {bug.occurrenceCount}×
              </span>
            )}

            {/* Source location */}
            {bug.sourceFile && (
              <span className="text-[10px] text-text-muted truncate max-w-[140px]">
                {bug.sourceFile.split('/').pop()}
                {bug.sourceLine ? `:${bug.sourceLine}` : ''}
              </span>
            )}

            {/* Resolved badge */}
            {bug.isResolved && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                Resolved
              </span>
            )}
          </div>

          {/* Timestamp */}
          <p className="text-[10px] text-text-muted mt-1">{formatRelativeTime(bug.lastSeenAt)}</p>
        </div>
      </div>
    </button>
  )
}
