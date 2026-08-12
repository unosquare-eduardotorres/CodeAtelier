import { useEffect, useMemo, useState } from 'react'
import type { MemoryFact, MemoryFactCategory } from '../../../../../../shared/types'
import {
  buildRows,
  countByCategory,
  countByTier,
  narrowAndSort,
  scopeFacts,
  validatedPercent
} from './facts-model'
import type { FactRowItem, SearchMode, SortMode, StatusFilter } from './types'

/** Delays a value so the search box stops firing an IPC call per keystroke. */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debounced
}

interface ModelInput {
  facts: MemoryFact[]
  categories: ReadonlySet<MemoryFactCategory>
  tiers: ReadonlySet<number>
  status: StatusFilter
  sort: SortMode
  searchMode: SearchMode
  /** Only applied in `filter` mode — semantic mode is resolved server-side. */
  query: string
  collapsedTiers: ReadonlySet<number>
}

interface ModelOutput {
  rows: FactRowItem[]
  matchCount: number
  tierCounts: Record<number, number>
  categoryCounts: Record<string, number>
  validatedPct: number
  /** Facts in scope before category/tier/search narrowing — drives the counts. */
  scopedCount: number
}

/**
 * Single source of truth for the memories list: status scoping, filtering,
 * sorting, and the flattened row model consumed by the virtualizer.
 *
 * The rules themselves live in `facts-model.ts`; this hook only memoizes them.
 */
export function useFactsModel({
  facts,
  categories,
  tiers,
  status,
  sort,
  searchMode,
  query,
  collapsedTiers
}: ModelInput): ModelOutput {
  const scoped = useMemo(() => scopeFacts(facts, status), [facts, status])

  // Counts describe the scoped set so the chips and the list never disagree.
  const tierCounts = useMemo(() => countByTier(scoped), [scoped])
  const categoryCounts = useMemo(() => countByCategory(scoped), [scoped])
  const validatedPct = useMemo(() => validatedPercent(scoped), [scoped])

  const filtered = useMemo(
    () =>
      narrowAndSort(scoped, {
        categories,
        tiers,
        sort,
        needle: searchMode === 'filter' ? query : ''
      }),
    [scoped, categories, tiers, sort, searchMode, query]
  )

  const rows = useMemo(
    () => buildRows(filtered, sort, collapsedTiers),
    [filtered, sort, collapsedTiers]
  )

  return {
    rows,
    matchCount: filtered.length,
    tierCounts,
    categoryCounts,
    validatedPct,
    scopedCount: scoped.length
  }
}
