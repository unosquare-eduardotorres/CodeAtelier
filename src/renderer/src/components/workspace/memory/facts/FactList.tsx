import { useCallback, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, Database } from 'lucide-react'

import FactRow, { type FactRowHandlers } from './FactRow'
import { TIER_LABELS, TIER_TEXT, type FactRowItem } from './types'

interface FactListProps extends FactRowHandlers {
  rows: FactRowItem[]
  expandedIds: ReadonlySet<string>
  onToggleExpand: (id: string) => void
  onToggleGroup: (tier: number) => void
  dimmed?: boolean
  /** A fetch is in flight — show placeholders instead of the empty state. */
  loading?: boolean
}

const GROUP_HEIGHT = 32
const ROW_HEIGHT = 36

/**
 * Virtualized memories list.
 *
 * Replaces the "Show more (N remaining)" batching — with 2700 memories the
 * old list needed 45 clicks to reach the end, and each tier group tracked its
 * own independent batch counter.
 */
export default function FactList({
  rows,
  expandedIds,
  onToggleExpand,
  onToggleGroup,
  dimmed,
  loading,
  ...handlers
}: FactListProps): React.JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => (rows[index]?.kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 12,
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) return index
      return row.kind === 'group' ? `tier-${row.tier}` : row.fact.id
    }
  })

  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) virtualizer.measureElement(el)
    },
    [virtualizer]
  )

  // The empty state is only honest once a load has finished. Showing it while
  // the first fetch is still in flight reads as "all memories are gone".
  if (rows.length === 0 && loading) {
    return (
      <div
        className="flex-1 min-h-0 overflow-hidden space-y-1 pt-1"
        data-testid="memory-fact-list-loading"
        aria-busy="true"
      >
        {Array.from({ length: 12 }, (_, i) => (
          <div
            key={i}
            className="h-9 rounded bg-surface-overlay/40 animate-pulse"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
        <span className="sr-only">Loading memories…</span>
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center py-16 text-text-muted">
        <Database className="w-8 h-8 mb-2 opacity-50" />
        <p className="text-sm">No memories match the current filters.</p>
        <p className="text-xs mt-1">
          Memories are automatically extracted from sessions, commits, and documents.
        </p>
      </div>
    )
  }

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-auto" data-testid="memory-fact-list">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          if (!row) return null
          return (
            <div
              key={item.key}
              ref={measure}
              data-index={item.index}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === 'group' ? (
                <button
                  type="button"
                  onClick={() => onToggleGroup(row.tier)}
                  aria-expanded={!row.collapsed}
                  className="flex items-center gap-2 w-full h-8 px-2 text-left rounded hover:bg-surface-overlay/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
                >
                  {row.collapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-text-muted" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
                  )}
                  <span className={`font-mono text-xs font-medium ${TIER_TEXT[row.tier]}`}>
                    {TIER_LABELS[row.tier]}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-text-muted">
                    {row.count}
                  </span>
                </button>
              ) : (
                <FactRow
                  fact={row.fact}
                  expanded={expandedIds.has(row.fact.id)}
                  onToggleExpand={() => onToggleExpand(row.fact.id)}
                  dimmed={dimmed}
                  {...handlers}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
