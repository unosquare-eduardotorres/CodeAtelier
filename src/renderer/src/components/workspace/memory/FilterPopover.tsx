/**
 * FilterPopover — stats bar + filter popover for the graph view.
 *
 * Pure presentational component — all filter state is lifted to GraphView.
 */

import { SlidersHorizontal } from 'lucide-react'
import { CATEGORY_COLOR_VAR, TIER_LABELS, ALL_TIERS } from './graph-constants'
import type { MemoryFactCategory, MemoryGraphEdgeKind } from '../../../../../shared/types'

// ── Props ──

interface FilterPopoverProps {
  nodeCount: number
  linkCount: number
  showFilters: boolean
  onToggleFilters: () => void
  filterCategories: Set<MemoryFactCategory>
  onToggleCategory: (cat: MemoryFactCategory) => void
  categoryCounts: Record<MemoryFactCategory, number>
  filterTiers: Set<number>
  onToggleTier: (t: number) => void
  tierCounts: Record<number, number>
  filterEdges: Set<MemoryGraphEdgeKind>
  onToggleEdge: (kind: MemoryGraphEdgeKind) => void
  hideSuperseded: boolean
  onToggleHideSuperseded: () => void
}

// ── Component ──

export default function FilterPopover({
  nodeCount,
  linkCount,
  showFilters,
  onToggleFilters,
  filterCategories,
  onToggleCategory,
  categoryCounts,
  filterTiers,
  onToggleTier,
  tierCounts,
  filterEdges,
  onToggleEdge,
  hideSuperseded,
  onToggleHideSuperseded
}: FilterPopoverProps): React.JSX.Element {
  return (
    <div className="absolute top-3 right-3 flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 bg-surface-raised/80 backdrop-blur-sm rounded-md border border-border-default px-2 py-1">
        <span className="text-[10px] text-text-muted">
          {nodeCount} memories · {linkCount} edges
        </span>
        <button
          onClick={onToggleFilters}
          className={`p-1 rounded ${showFilters ? 'text-info bg-info/10' : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'}`}
          title="Filters"
        >
          <SlidersHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {showFilters && (
        <div className="bg-surface-raised/95 backdrop-blur-sm border border-border-default rounded-md p-3 text-xs space-y-3 w-56 shadow-lg">
          {/* Categories */}
          <div>
            <p className="font-medium text-text-primary mb-1.5">Categories</p>
            {(['decision', 'convention', 'gotcha', 'preference', 'reference'] as const).map(
              (cat) => (
                <label
                  key={cat}
                  className="flex items-center gap-2 py-0.5 text-text-secondary cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={filterCategories.has(cat)}
                    onChange={() => onToggleCategory(cat)}
                    className="rounded border-border-default accent-primary"
                  />
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: `var(${CATEGORY_COLOR_VAR[cat]})` }}
                  />
                  <span className="flex-1">{cat}</span>
                  <span className="text-text-muted">{categoryCounts[cat] ?? 0}</span>
                </label>
              )
            )}
          </div>
          {/* Tiers */}
          <div>
            <p className="font-medium text-text-primary mb-1.5">Tiers</p>
            {ALL_TIERS.map((t) => (
              <label
                key={t}
                className="flex items-center gap-2 py-0.5 text-text-secondary cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={filterTiers.has(t)}
                  onChange={() => onToggleTier(t)}
                  className="rounded border-border-default accent-primary"
                />
                <span className="flex-1">{TIER_LABELS[t]}</span>
                <span className="text-text-muted">{tierCounts[t] ?? 0}</span>
              </label>
            ))}
          </div>
          {/* Edge kinds */}
          <div>
            <p className="font-medium text-text-primary mb-1.5">Edge types</p>
            {(['similarity', 'superseded', 'contradiction', 'derived'] as const).map((kind) => (
              <label
                key={kind}
                className="flex items-center gap-2 py-0.5 text-text-secondary cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={filterEdges.has(kind)}
                  onChange={() => onToggleEdge(kind)}
                  className="rounded border-border-default accent-primary"
                />
                {kind}
              </label>
            ))}
          </div>
          {/* Hide superseded toggle */}
          <label className="flex items-center gap-2 pt-1 border-t border-border-default text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={hideSuperseded}
              onChange={onToggleHideSuperseded}
              className="rounded border-border-default accent-primary"
            />
            Hide superseded/archived
          </label>
        </div>
      )}
    </div>
  )
}
