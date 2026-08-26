import { ArrowDownWideNarrow, ArrowUpNarrowWide, Filter, Layers } from 'lucide-react'
import {
  JIRA_SORT_FIELDS,
  JIRA_SORT_LABELS,
  type JiraSortDir,
  type JiraSortField
} from '../../../../../shared/jira-list-view'

const SELECT_CLASS =
  'bg-surface-overlay border border-border-default rounded px-1.5 py-1 text-[11px] text-text-primary'

/**
 * Filter / sort / group controls for the loaded ticket rows.
 *
 * The sort control is the only one here that can reach the network: when the
 * result set is not fully loaded, ordering has to happen in Jira or it would be
 * ranking a slice — see `useJiraTickets.setSort`. `isServerSorted` is surfaced
 * so the ordering's provenance is visible rather than implied.
 */
export default function JiraListControls({
  filterText,
  onFilterChange,
  filterInputRef,
  sortField,
  sortDir,
  onSortChange,
  isServerSorted,
  grouped,
  onGroupedChange
}: {
  filterText: string
  onFilterChange: (text: string) => void
  filterInputRef?: React.RefObject<HTMLInputElement | null>
  sortField: JiraSortField
  sortDir: JiraSortDir
  onSortChange: (field: JiraSortField, dir: JiraSortDir) => void
  isServerSorted: boolean
  grouped: boolean
  onGroupedChange: (grouped: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="jira-list-controls">
      <div className="relative flex-1 min-w-[160px]">
        <Filter
          size={11}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
        />
        <input
          ref={filterInputRef}
          aria-label="Filter tickets"
          data-testid="jira-filter-input"
          value={filterText}
          onChange={(e) => onFilterChange(e.target.value)}
          spellCheck={false}
          placeholder="Filter loaded tickets — press / to focus"
          className="w-full bg-surface-overlay border border-border-default rounded pl-6 pr-2 py-1 text-[11px] text-text-primary"
        />
      </div>

      <label className="flex items-center gap-1 text-[11px] text-text-muted">
        Sort
        <select
          aria-label="Sort field"
          data-testid="jira-sort-field"
          value={sortField}
          onChange={(e) => onSortChange(e.target.value as JiraSortField, sortDir)}
          className={SELECT_CLASS}
        >
          {JIRA_SORT_FIELDS.map((field) => (
            <option key={field} value={field}>
              {JIRA_SORT_LABELS[field]}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        data-testid="jira-sort-dir"
        aria-label={sortDir === 'asc' ? 'Sort ascending' : 'Sort descending'}
        title={
          sortDir === 'asc'
            ? 'Ascending — click for descending'
            : 'Descending — click for ascending'
        }
        onClick={() => onSortChange(sortField, sortDir === 'asc' ? 'desc' : 'asc')}
        className="p-1 rounded border border-border-subtle text-text-secondary hover:border-accent hover:text-accent transition-colors"
      >
        {sortDir === 'asc' ? <ArrowUpNarrowWide size={12} /> : <ArrowDownWideNarrow size={12} />}
      </button>

      {isServerSorted && (
        <span
          data-testid="jira-sorted-in-jira"
          title="More pages exist, so Jira applied this ordering across the whole result set rather than the panel ordering the loaded page."
          className="text-[10px] px-1.5 py-0.5 rounded-full border border-info/20 bg-info-muted text-info"
        >
          sorted in Jira
        </span>
      )}

      <button
        type="button"
        data-testid="jira-group-toggle"
        aria-pressed={grouped}
        onClick={() => onGroupedChange(!grouped)}
        className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
          grouped
            ? 'border-accent/40 bg-surface-overlay text-accent'
            : 'border-border-subtle text-text-secondary hover:border-accent hover:text-accent'
        }`}
      >
        <Layers size={11} />
        Group by project
      </button>
    </div>
  )
}
