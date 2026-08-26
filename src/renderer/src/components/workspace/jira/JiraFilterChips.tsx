import { useState } from 'react'
import { Pin, X } from 'lucide-react'
import { JIRA_QUICK_FILTERS } from '../../../../../shared/jira.types'
import { JIRA_MAX_SAVED_FILTERS, type JiraSavedFilter } from './jira-view-state'

const CHIP_CLASS =
  'text-[11px] px-2 py-0.5 rounded-full border border-border-subtle text-text-secondary hover:border-accent hover:text-accent transition-colors'

/**
 * The JQL shortcut row: four built-in chips plus whatever the user has pinned.
 *
 * Pinning exists because `JIRA_QUICK_FILTERS` is a hardcoded const of four, and
 * the query someone actually lives in ("my team's board, unresolved, this
 * release") is never one of them.
 *
 * The naming step is an inline input rather than `window.prompt` — Electron
 * renderers do not implement prompt(), so it would silently do nothing.
 */
export default function JiraFilterChips({
  savedFilters,
  onApply,
  onSave,
  onRemove
}: {
  savedFilters: JiraSavedFilter[]
  onApply: (jql: string) => void
  onSave: (label: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element {
  const [label, setLabel] = useState<string | null>(null)

  const commit = (): void => {
    const trimmed = (label ?? '').trim()
    if (trimmed.length > 0) onSave(trimmed)
    setLabel(null)
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="jira-filter-chips">
      {JIRA_QUICK_FILTERS.map((filter) => (
        <button
          key={filter.id}
          type="button"
          onClick={() => onApply(filter.jql)}
          className={CHIP_CLASS}
        >
          {filter.label}
        </button>
      ))}

      {savedFilters.map((filter) => (
        <span
          key={filter.id}
          data-testid={`jira-saved-filter-${filter.id}`}
          className="flex items-center rounded-full border border-accent/30 text-accent"
        >
          <button
            type="button"
            onClick={() => onApply(filter.jql)}
            title={filter.jql}
            className="text-[11px] pl-2 pr-1 py-0.5 hover:underline"
          >
            {filter.label}
          </button>
          <button
            type="button"
            aria-label={`Remove ${filter.label}`}
            onClick={() => onRemove(filter.id)}
            className="pr-1.5 pl-0.5 text-text-muted hover:text-danger transition-colors"
          >
            <X size={10} />
          </button>
        </span>
      ))}

      {label === null ? (
        savedFilters.length < JIRA_MAX_SAVED_FILTERS && (
          <button
            type="button"
            data-testid="jira-pin-filter"
            title="Pin the current JQL as a chip"
            onClick={() => setLabel('')}
            className={`${CHIP_CLASS} flex items-center gap-1`}
          >
            <Pin size={10} />
            Pin current
          </button>
        )
      ) : (
        <input
          autoFocus
          aria-label="Name for the pinned filter"
          data-testid="jira-pin-filter-name"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setLabel(null)
          }}
          placeholder="Chip name…"
          maxLength={60}
          className="bg-surface-overlay border border-accent/40 rounded-full px-2 py-0.5 text-[11px] text-text-primary w-32"
        />
      )}
    </div>
  )
}
