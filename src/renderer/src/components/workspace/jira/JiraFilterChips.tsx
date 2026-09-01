import { useState } from 'react'
import { Pin } from 'lucide-react'
import { Chip } from '@renderer/components/common/ui'
import { JIRA_QUICK_FILTERS } from '../../../../../shared/jira.types'
import { JIRA_MAX_SAVED_FILTERS, type JiraSavedFilter } from './jira-view-state'

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
        <Chip key={filter.id} onClick={() => onApply(filter.jql)}>
          {filter.label}
        </Chip>
      ))}

      {savedFilters.map((filter) => (
        <Chip
          key={filter.id}
          active
          data-testid={`jira-saved-filter-${filter.id}`}
          title={filter.jql}
          onClick={() => onApply(filter.jql)}
          onDismiss={() => onRemove(filter.id)}
        >
          {filter.label}
        </Chip>
      ))}

      {label === null ? (
        savedFilters.length < JIRA_MAX_SAVED_FILTERS && (
          <Chip
            data-testid="jira-pin-filter"
            title="Pin the current JQL as a chip"
            onClick={() => setLabel('')}
          >
            <Pin size={11} />
            Pin current
          </Chip>
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
