import { Search, Plus } from 'lucide-react'

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'complete', label: 'Complete' },
  { value: 'failed', label: 'Failed' }
] as const

export type BlueprintFilter = (typeof FILTER_TABS)[number]['value']

interface BlueprintFilterBarProps {
  filter: BlueprintFilter
  searchQuery: string
  counts: Record<BlueprintFilter, number>
  onFilterChange: (filter: BlueprintFilter) => void
  onSearchChange: (query: string) => void
  onNewBlueprint: () => void
}

export default function BlueprintFilterBar({
  filter,
  searchQuery,
  counts,
  onFilterChange,
  onSearchChange,
  onNewBlueprint
}: BlueprintFilterBarProps): React.JSX.Element {
  return (
    <div data-testid="blueprint-filter-bar" className="flex items-center gap-3 mb-3">
      <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => onFilterChange(tab.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === tab.value
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
            }`}
          >
            {tab.label}
            {counts[tab.value] > 0 && (
              <span className="ml-1 text-[10px] opacity-60">{counts[tab.value]}</span>
            )}
          </button>
        ))}
      </div>
      <div className="relative flex-1 max-w-xs">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search blueprints..."
          className="w-full pl-8 pr-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500/50 transition-colors"
        />
      </div>
      <button
        onClick={onNewBlueprint}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg transition-colors ml-auto"
      >
        <Plus size={14} />
        New Blueprint
      </button>
    </div>
  )
}
