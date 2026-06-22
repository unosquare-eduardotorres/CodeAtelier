// @ts-nocheck — TODO: fix after blueprint refactoring
/**
 * useBlueprintFilterState — filter + search state for blueprint history.
 * Extracted from useBlueprintPageState to reduce cyclomatic complexity.
 */
import { useState, useMemo } from 'react'
import { BLUEPRINT_ACTIVE_STATUSES } from '.'
import type { BlueprintFilter } from '.'
import type { Blueprint } from '../../../../../shared/blueprint-types'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function useBlueprintFilterState(history: Blueprint[]) {
  const [filter, setFilter] = useState<BlueprintFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const filteredHistory = useMemo(() => {
    let result = history
    if (filter !== 'all') {
      result = result.filter((bp) => {
        if (filter === 'active') return BLUEPRINT_ACTIVE_STATUSES.has(bp.status)
        if (filter === 'complete') return bp.status === 'complete'
        if (filter === 'failed') return bp.status === 'failed'
        return true
      })
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter(
        (bp) =>
          bp.title.toLowerCase().includes(q) || (bp.description ?? '').toLowerCase().includes(q)
      )
    }
    return result
  }, [history, filter, searchQuery])

  const filterCounts = useMemo<Record<BlueprintFilter, number>>(
    () => ({
      all: history.length,
      active: history.filter((bp) => BLUEPRINT_ACTIVE_STATUSES.has(bp.status)).length,
      complete: history.filter((bp) => bp.status === 'complete').length,
      failed: history.filter((bp) => bp.status === 'failed').length
    }),
    [history]
  )

  const resetFilters = (): void => {
    setFilter('all')
    setSearchQuery('')
  }

  return {
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    filteredHistory,
    filterCounts,
    resetFilters
  }
}
