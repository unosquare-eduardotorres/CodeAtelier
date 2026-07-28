import { AlertTriangle, Skull, CheckCircle2, Clock } from 'lucide-react'
import type { BugRecord } from '../../../../shared/types'

interface BugSummaryBarProps {
  bugs: BugRecord[]
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

export default function BugSummaryBar({ bugs }: BugSummaryBarProps): React.JSX.Element {
  const fatalCount = bugs.filter((b) => b.severity === 'fatal' && !b.isResolved).length
  const errorCount = bugs.filter((b) => b.severity === 'error' && !b.isResolved).length
  const resolvedCount = bugs.filter((b) => b.isResolved).length
  const unresolvedPct = bugs.length > 0 ? Math.round(((bugs.length - resolvedCount) / bugs.length) * 100) : 0
  const resolvedPct = 100 - unresolvedPct
  const mostRecent = bugs[0] ?? null

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-overlay">
      <div className="flex items-center justify-between px-4 py-3">
        {/* Left: severity counts */}
        <div className="flex items-center gap-4">
          {fatalCount > 0 && (
            <span className="flex items-center gap-1 text-xs text-danger font-medium">
              <Skull size={12} /> {fatalCount} fatal
            </span>
          )}

          <span className="flex items-center gap-1 text-xs text-warning">
            <AlertTriangle size={12} /> {errorCount} error{errorCount !== 1 ? 's' : ''}
          </span>

          <div className="border-l border-border-subtle h-6" />

          <span className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 size={12} /> {resolvedCount} resolved
          </span>

          <div className="border-l border-border-subtle h-6" />

          {/* Unresolved ratio bar */}
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-20 rounded-full bg-surface-base overflow-hidden flex">
              <div className="bg-danger" style={{ width: `${unresolvedPct}%` }} />
              <div className="bg-success" style={{ width: `${resolvedPct}%` }} />
            </div>
            <span className="text-xs text-text-muted tabular-nums">{unresolvedPct}% open</span>
          </div>
        </div>

        {/* Right: last bug timestamp */}
        {mostRecent && (
          <span className="flex items-center gap-1 text-xs text-text-muted shrink-0">
            <Clock size={12} /> Last: {formatRelativeTime(mostRecent.lastSeenAt)}
          </span>
        )}
      </div>
    </div>
  )
}
