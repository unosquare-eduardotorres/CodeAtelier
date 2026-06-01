import { Search, Plus } from 'lucide-react'

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' }
] as const

export type CouncilFilter = (typeof FILTER_TABS)[number]['value']

interface CouncilFilterBarProps {
  filter: CouncilFilter
  searchQuery: string
  onFilterChange: (filter: CouncilFilter) => void
  onSearchChange: (query: string) => void
  onNewCouncil: () => void
}

export default function CouncilFilterBar({
  filter,
  searchQuery,
  onFilterChange,
  onSearchChange,
  onNewCouncil
}: CouncilFilterBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => onFilterChange(tab.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === tab.value
                ? 'bg-purple-500/20 text-purple-400'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-float'
            }`}
          >
            {tab.label}
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
          placeholder="Search council sessions..."
          className="w-full pl-8 pr-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors"
        />
      </div>
      <button
        onClick={onNewCouncil}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 rounded-lg transition-colors ml-auto"
      >
        <Plus size={14} />
        New Council
      </button>
    </div>
  )
}
