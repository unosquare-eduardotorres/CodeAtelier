import { ArrowUpDown, HelpCircle, Search, Sparkles, X } from 'lucide-react'

import {
  Button,
  Chip,
  FilterMenu,
  Popover,
  SegmentedControl,
  SelectMenu,
  Tooltip,
  type FilterOption
} from '@renderer/components/common/ui'
import { CATEGORY_META } from '../category-meta'
import {
  ALL_CATEGORIES,
  ALL_TIERS,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  TIER_LABELS,
  TIER_TEXT,
  type SearchMode,
  type SortMode,
  type StatusFilter
} from './types'
import type { MemoryFactCategory } from '../../../../../../shared/types'

interface FactsToolbarProps {
  query: string
  onQueryChange: (q: string) => void
  searchMode: SearchMode
  onSearchModeChange: (m: SearchMode) => void
  categories: Set<MemoryFactCategory>
  onCategoriesChange: (next: Set<MemoryFactCategory>) => void
  tiers: Set<number>
  onTiersChange: (next: Set<number>) => void
  status: StatusFilter
  onStatusChange: (s: StatusFilter) => void
  sort: SortMode
  onSortChange: (s: SortMode) => void
  tierCounts: Record<number, number>
  categoryCounts: Record<string, number>
  validatedPct: number
  matchCount: number
  scopedCount: number
  insightsOpen: boolean
  onToggleInsights: () => void
}

const SEARCH_MODES = [
  {
    value: 'filter' as const,
    label: 'Filter',
    title: 'Instant substring match on loaded memories'
  },
  {
    value: 'semantic' as const,
    label: 'Semantic',
    title: 'Embedding search across the whole database — replaces the list'
  }
]

/**
 * The single control row for the memories list.
 *
 * Collapses what used to be five stacked rows (explainer accordion, tier
 * chips, category chips, two native selects, search field) into one toolbar
 * plus an active-filter row that only appears when something is filtered.
 */
export default function FactsToolbar({
  query,
  onQueryChange,
  searchMode,
  onSearchModeChange,
  categories,
  onCategoriesChange,
  tiers,
  onTiersChange,
  status,
  onStatusChange,
  sort,
  onSortChange,
  tierCounts,
  categoryCounts,
  validatedPct,
  matchCount,
  scopedCount,
  insightsOpen,
  onToggleInsights
}: FactsToolbarProps): React.JSX.Element {
  const tierOptions: FilterOption<number>[] = ALL_TIERS.map((t) => ({
    value: t,
    label: TIER_LABELS[t],
    count: tierCounts[t],
    toneClass: `font-mono ${TIER_TEXT[t]}`
  }))

  const categoryOptions: FilterOption<MemoryFactCategory>[] = ALL_CATEGORIES.map((c) => ({
    value: c,
    label: CATEGORY_META[c].label,
    count: categoryCounts[c] ?? 0
  }))

  const tiersFiltered = tiers.size !== ALL_TIERS.length
  const categoriesFiltered = categories.size !== ALL_CATEGORIES.length
  const hasFilters = tiersFiltered || categoriesFiltered || status !== 'all' || query.trim() !== ''

  const clearAll = (): void => {
    onTiersChange(new Set(ALL_TIERS))
    onCategoriesChange(new Set(ALL_CATEGORIES))
    onStatusChange('all')
    onQueryChange('')
  }

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 flex-wrap py-2">
        {/* Search */}
        <div className="relative flex-1 min-w-[16rem]">
          {searchMode === 'semantic' ? (
            <Sparkles className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-primary-text" />
          ) : (
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={
              searchMode === 'semantic'
                ? 'Semantic search across all memories…'
                : 'Filter loaded memories…'
            }
            aria-label={searchMode === 'semantic' ? 'Semantic search' : 'Filter memories'}
            data-testid="memory-search-input"
            className="w-full h-7 pl-8 pr-8 bg-input-bg border border-border-default rounded-md text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-input-focus"
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <SegmentedControl
          value={searchMode}
          segments={SEARCH_MODES}
          onChange={onSearchModeChange}
          ariaLabel="Search mode"
        />

        <FilterMenu label="Tier" options={tierOptions} selected={tiers} onChange={onTiersChange} />
        <FilterMenu
          label="Category"
          options={categoryOptions}
          selected={categories}
          onChange={onCategoriesChange}
        />
        <SelectMenu
          value={status}
          options={STATUS_OPTIONS}
          onChange={onStatusChange}
          ariaLabel="Status filter"
        />
        <SelectMenu
          icon={<ArrowUpDown className="w-3 h-3" />}
          value={sort}
          options={SORT_OPTIONS}
          onChange={onSortChange}
          ariaLabel="Sort order"
        />

        <Tooltip content="Inspect how a query scores against each memory">
          <Button
            variant={insightsOpen ? 'primary' : 'ghost'}
            size="sm"
            iconOnly
            aria-label="Match insights"
            aria-pressed={insightsOpen}
            onClick={onToggleInsights}
          >
            <Sparkles className="w-3.5 h-3.5" />
          </Button>
        </Tooltip>

        <Popover
          align="end"
          className="w-80 p-3"
          trigger={(props) => (
            <button
              type="button"
              aria-label="How the Brain works"
              {...props}
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-focus"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
          )}
        >
          <ExplainerContent />
        </Popover>
      </div>

      {/* Active filters — only rendered when something is actually narrowed.
          Every chip means exactly one thing: "remove this filter". Clicking the
          label used to reset the whole dimension while × removed one value,
          which is the same undiscoverable dual behaviour the chip rows had. */}
      {hasFilters && (
        <div className="flex items-center gap-1.5 flex-wrap pb-2">
          {tiersFiltered &&
            [...tiers].sort().map((t) => (
              <Chip
                key={`tier-${t}`}
                active
                onDismiss={() => {
                  const next = new Set(tiers)
                  next.delete(t)
                  onTiersChange(next.size === 0 ? new Set(ALL_TIERS) : next)
                }}
              >
                {TIER_LABELS[t]}
              </Chip>
            ))}
          {categoriesFiltered &&
            [...categories].map((c) => (
              <Chip
                key={c}
                active
                onDismiss={() => {
                  const next = new Set(categories)
                  next.delete(c)
                  onCategoriesChange(next.size === 0 ? new Set(ALL_CATEGORIES) : next)
                }}
              >
                {CATEGORY_META[c].label}
              </Chip>
            ))}
          {status !== 'all' && (
            <Chip active onDismiss={() => onStatusChange('all')}>
              {STATUS_OPTIONS.find((s) => s.value === status)?.label}
            </Chip>
          )}
          <button
            type="button"
            onClick={clearAll}
            className="text-[11px] text-text-muted hover:text-text-primary underline underline-offset-2"
          >
            Clear all
          </button>
        </div>
      )}

      {/* One count line — the old page showed tier counts, a validated
          percentage and per-category counts simultaneously with no relation. */}
      <div className="flex items-center gap-3 pb-2 text-[11px] text-text-muted">
        <span className="font-mono tabular-nums">
          {matchCount === scopedCount
            ? `${scopedCount} memories`
            : `${matchCount} of ${scopedCount} memories`}
        </span>
        <span aria-hidden="true">·</span>
        <span>{validatedPct}% validated</span>
      </div>
    </div>
  )
}

// ── Explainer (moved out of a permanent accordion row) ──

const TIERS = [
  { label: 'T0 Observed', confirms: '—', color: 'text-text-muted', dot: 'bg-text-muted' },
  { label: 'T1 Confirmed', confirms: '3', color: 'text-info', dot: 'bg-info' },
  { label: 'T2 Established', confirms: '5', color: 'text-success', dot: 'bg-success' },
  { label: 'T3 Wisdom', confirms: '8', color: 'text-primary-text', dot: 'bg-primary-text' }
]

function ExplainerContent(): React.JSX.Element {
  return (
    <div className="space-y-3 text-xs text-text-secondary">
      <div>
        <p className="font-medium text-text-primary mb-1.5">Promotion ladder</p>
        <ul className="space-y-1">
          {TIERS.map((tier, i) => (
            <li key={tier.label} className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full ${tier.dot}`} />
              <span className={`font-mono ${tier.color}`}>{tier.label}</span>
              {i > 0 && (
                <span className="ml-auto font-mono text-text-muted">{tier.confirms}× confirms</span>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-text-muted leading-relaxed">
          Higher tiers rank higher in retrieval and survive longer. Established also needs two kinds
          of evidence over a 14-day span; Wisdom additionally requires human confirmations and a
          30-day span. Spans are measured from the oldest confirmation to now, and tiers are
          re-evaluated during consolidation — so evidence corroborated on more than one day keeps
          maturing without a new confirmation. A single day&rsquo;s confirmations never age up on
          their own.
        </p>
      </div>
      <div>
        <p className="font-medium text-text-primary mb-1.5">Categories</p>
        <ul className="space-y-1">
          {ALL_CATEGORIES.map((cat) => (
            <li key={cat} className="flex items-baseline gap-1.5">
              <span className="font-medium text-text-primary">{CATEGORY_META[cat].label}</span>
              <span className="text-text-muted">— {CATEGORY_META[cat].description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
