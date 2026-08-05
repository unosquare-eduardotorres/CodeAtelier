/**
 * ItemList — per-document rows for an ingestion run.
 *
 * This is the answer to "which documents, how far in, how many memories each".
 * Rows are windowed with a plain scroll container rather than a virtualiser:
 * the list is capped at 200 rows per page by the store, so the extra dependency
 * would not earn its keep.
 */

import { useMemo } from 'react'
import { Loader2, CheckCircle, MinusCircle, XCircle, Clock } from 'lucide-react'
import type { BootstrapItemStatus, BootstrapItemView } from '../../../../../../shared/types'
import { PHASE_INFO } from './phase-meta'

const FILTERS: Array<{ id: BootstrapItemStatus | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'done', label: 'Done' },
  { id: 'pending', label: 'Pending' },
  { id: 'skipped', label: 'Unchanged' },
  { id: 'failed', label: 'Failed' }
]

function StatusPill({ status }: { status: BootstrapItemStatus }): React.JSX.Element {
  switch (status) {
    case 'running':
      return (
        <span className="flex items-center gap-1 text-teal text-[10px]">
          <Loader2 className="w-3 h-3 animate-spin" /> running
        </span>
      )
    case 'done':
      return (
        <span className="flex items-center gap-1 text-green-400 text-[10px]">
          <CheckCircle className="w-3 h-3" /> done
        </span>
      )
    case 'skipped':
      return (
        <span className="flex items-center gap-1 text-text-muted text-[10px]">
          <MinusCircle className="w-3 h-3" /> unchanged
        </span>
      )
    case 'failed':
      return (
        <span className="flex items-center gap-1 text-red-400 text-[10px]">
          <XCircle className="w-3 h-3" /> failed
        </span>
      )
    default:
      return (
        <span className="flex items-center gap-1 text-text-muted text-[10px]">
          <Clock className="w-3 h-3" /> queued
        </span>
      )
  }
}

export default function ItemList({
  items,
  total,
  filter,
  onFilterChange
}: {
  items: BootstrapItemView[]
  total: number
  filter: BootstrapItemStatus | 'all'
  onFilterChange: (filter: BootstrapItemStatus | 'all') => void
}): React.JSX.Element {
  // Counts are derived from the loaded page, so they are only truthful when
  // that page covers the whole run. On a larger run they would silently
  // under-report, which is worse than showing nothing — `total` stays correct
  // either way.
  const countsAreComplete = items.length >= total
  const counts = useMemo(() => {
    const acc: Record<string, number> = {}
    for (const item of items) acc[item.status] = (acc[item.status] ?? 0) + 1
    return acc
  }, [items])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => onFilterChange(f.id)}
            className={`px-2 py-0.5 text-[11px] rounded transition-colors ${
              filter === f.id
                ? 'bg-teal/15 text-teal'
                : 'text-text-muted hover:text-text-secondary hover:bg-surface-overlay'
            }`}
          >
            {f.label}
            {f.id !== 'all' && countsAreComplete && counts[f.id] ? (
              <span className="ml-1 font-mono opacity-70">{counts[f.id]}</span>
            ) : null}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-text-muted font-mono">
          {items.length} of {total}
        </span>
      </div>

      <div className="max-h-72 overflow-y-auto rounded border border-border-subtle divide-y divide-border-subtle">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-text-muted">
            No items match this filter.
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-surface-overlay/50"
            >
              <span className="text-text-muted shrink-0" title={item.phase}>
                {PHASE_INFO[item.phase]?.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={item.sourceRef}>
                {item.sourceRef}
              </span>

              {item.chunkTotal > 1 && (
                <span className="font-mono text-[10px] text-text-muted shrink-0">
                  {item.chunkDone}/{item.chunkTotal}
                </span>
              )}

              {item.factsCreated > 0 && (
                <span className="font-mono text-[10px] text-teal shrink-0">
                  +{item.factsCreated}
                </span>
              )}

              <span className="shrink-0 w-20 text-right">
                <StatusPill status={item.status} />
              </span>
            </div>
          ))
        )}
      </div>

      {items.some((i) => i.error) && (
        <div className="text-[10px] text-red-400/80 space-y-0.5">
          {items
            .filter((i) => i.error)
            .slice(0, 5)
            .map((i) => (
              <div key={i.id} className="truncate">
                {i.sourceRef}: {i.error}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
