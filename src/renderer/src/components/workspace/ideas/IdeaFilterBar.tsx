import { Search, Plus } from 'lucide-react'

const FILTER_TABS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' }
] as const

export type IdeaFilter = (typeof FILTER_TABS)[number]['value']

interface IdeaFilterBarProps {
  filter: IdeaFilter
  searchQuery: string
  onFilterChange: (filter: IdeaFilter) => void
  onSearchChange: (query: string) => void
  onNewIdea: () => void
}

export default function IdeaFilterBar({
  filter,
  searchQuery,
  onFilterChange,
  onSearchChange,
  onNewIdea
}: IdeaFilterBarProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 mb-3">
      <div className="flex items-center bg-surface-overlay border border-border-subtle rounded-lg p-0.5">
        {FILTER_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => onFilterChange(tab.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              filter === tab.value
                ? 'bg-primary/20 text-primary-text'
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
          placeholder="Search ideas..."
          className="w-full pl-8 pr-3 py-2 rounded-lg bg-surface-overlay border border-border-subtle text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-colors"
        />
      </div>
      <button
        onClick={onNewIdea}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-warning/20 hover:bg-warning/30 text-warning rounded-lg transition-colors ml-auto"
      >
        <Plus size={14} />
        New Idea
      </button>
    </div>
  )
}
