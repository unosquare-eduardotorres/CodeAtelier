/**
 * PlanStatusTimeline — vertical timeline showing each status transition
 * in a plan's lifecycle history.
 */

import type { PlanStatusHistoryEntry, PlanStatus } from '../../../../../shared/types'
import { STATUS_CONFIG } from './plan-constants'

// ── Dot color per status ──

function dotColor(status: PlanStatus): string {
  const cfg = STATUS_CONFIG[status]
  if (!cfg) return 'bg-text-muted border-text-muted'
  // Strip animate-pulse from dotColor if present (not relevant in timeline)
  const base = cfg.dotColor.replace(' animate-pulse', '')
  return `${base} border-${base.replace('bg-', '')}`
}

function statusLabel(status: PlanStatus): string {
  return STATUS_CONFIG[status]?.label ?? status
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

// ── Component ──

export default function PlanStatusTimeline({
  history
}: {
  history: PlanStatusHistoryEntry[]
}): React.JSX.Element {
  if (history.length === 0) {
    return <p className="text-xs text-text-muted italic">No status history available.</p>
  }

  return (
    <div className="space-y-0">
      {history.map((entry, i) => (
        <div key={entry.id} className="flex items-start gap-3 relative">
          {/* Vertical line connector */}
          {i < history.length - 1 && (
            <div className="absolute left-[7px] top-[18px] w-px h-full bg-border-subtle" />
          )}
          {/* Status dot */}
          <span
            className={`w-[15px] h-[15px] rounded-full mt-0.5 flex-shrink-0 border-2 ${dotColor(entry.toStatus)}`}
          />
          {/* Content */}
          <div className="flex-1 pb-4">
            <span className="text-sm font-medium text-text-primary">
              {statusLabel(entry.toStatus)}
            </span>
            <div className="text-[11px] text-text-muted">
              {formatDate(entry.changedAt)} · {entry.actor}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
