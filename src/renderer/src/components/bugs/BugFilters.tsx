import type { BugFilters as BugFiltersType } from '@renderer/store/bug.store'

interface BugFiltersProps {
  filters: BugFiltersType
  onFilterChange: (filters: Partial<BugFiltersType>) => void
}

export default function BugFilters({ filters, onFilterChange }: BugFiltersProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {/* Process filter */}
      <select
        value={filters.process ?? ''}
        onChange={(e) =>
          onFilterChange({
            process: (e.target.value || undefined) as BugFiltersType['process']
          })
        }
        className="px-3 py-1.5 bg-surface-overlay border border-border-subtle rounded-md text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
      >
        <option value="">All Processes</option>
        <option value="main">Main</option>
        <option value="renderer">Renderer</option>
        <option value="preload">Preload</option>
      </select>

      {/* Status filter */}
      <select
        value={filters.isResolved === undefined ? '' : filters.isResolved ? 'resolved' : 'open'}
        onChange={(e) => {
          const val = e.target.value
          onFilterChange({
            isResolved: val === '' ? undefined : val === 'resolved'
          })
        }}
        className="px-3 py-1.5 bg-surface-overlay border border-border-subtle rounded-md text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
      >
        <option value="">All Status</option>
        <option value="open">Open</option>
        <option value="resolved">Resolved</option>
      </select>

      {/* Sort */}
      <select
        value={`${filters.sortBy ?? 'last_seen_at'}-${filters.sortDir ?? 'desc'}`}
        onChange={(e) => {
          const [sortBy, sortDir] = e.target.value.split('-') as [
            BugFiltersType['sortBy'],
            BugFiltersType['sortDir']
          ]
          onFilterChange({ sortBy, sortDir })
        }}
        className="px-3 py-1.5 bg-surface-overlay border border-border-subtle rounded-md text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/50"
      >
        <option value="last_seen_at-desc">Newest First</option>
        <option value="last_seen_at-asc">Oldest First</option>
        <option value="occurrence_count-desc">Most Occurrences</option>
        <option value="severity-desc">Severity</option>
      </select>
    </div>
  )
}
