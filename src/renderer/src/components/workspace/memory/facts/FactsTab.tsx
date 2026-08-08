import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useMemoryStore } from '@renderer/store'
import MemorySearchPlayground from '../MemorySearchPlayground'
import FactList from './FactList'
import FactsToolbar from './FactsToolbar'
import { useDebouncedValue, useFactsModel } from './useFactsModel'
import { readFilters, writeFilters } from './facts-prefs'
import { type SearchMode, type SortMode, type StatusFilter } from './types'
import type { MemoryFactCategory } from '../../../../../../shared/types'

interface FactsTabProps {
  workspaceId: string
}

/**
 * Memories tab — toolbar, active filters and the virtualized list.
 *
 * Default sort is `newest` (a flat list). Tier grouping used to be the
 * default, and because T2/T3 were the only groups opened by default — and
 * both were empty — the page rendered as if it held no memories at all.
 */
export default function FactsTab({ workspaceId }: FactsTabProps): React.JSX.Element {
  const {
    facts,
    factsLoading,
    loadFacts,
    searchFacts,
    confirmFact,
    archiveFact,
    deleteFact,
    toggleScope,
    updateFact,
    setSearchQuery
  } = useMemoryStore()

  const [stored] = useState(readFilters)
  const [query, setQuery] = useState('')
  const [searchMode, setSearchMode] = useState<SearchMode>('filter')
  const [categories, setCategories] = useState<Set<MemoryFactCategory>>(
    () => new Set(stored.categories)
  )
  const [tiers, setTiers] = useState<Set<number>>(() => new Set(stored.tiers))
  const [status, setStatus] = useState<StatusFilter>(stored.status)
  const [sort, setSort] = useState<SortMode>(stored.sort)
  const [collapsedTiers, setCollapsedTiers] = useState<Set<number>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [insightsOpen, setInsightsOpen] = useState(false)

  // Survives a tab switch — narrowing the list then glancing at Review used
  // to throw the narrowing away.
  useEffect(() => {
    writeFilters({ categories: [...categories], tiers: [...tiers], status, sort })
  }, [categories, tiers, status, sort])

  // 300ms debounce — the old field fired an IPC round-trip on every keystroke.
  const debouncedQuery = useDebouncedValue(query, 300)
  const lastDispatched = useRef<string | null>(null)

  useEffect(() => {
    if (searchMode !== 'semantic') return
    const trimmed = debouncedQuery.trim()
    if (lastDispatched.current === trimmed) return
    lastDispatched.current = trimmed
    setSearchQuery(trimmed)
    if (trimmed) searchFacts(workspaceId, trimmed)
    else loadFacts(workspaceId)
  }, [debouncedQuery, searchMode, workspaceId])

  const handleSearchModeChange = useCallback(
    (mode: SearchMode) => {
      setSearchMode(mode)
      if (mode === 'filter') {
        // Leaving semantic mode restores the full list the filter operates on.
        lastDispatched.current = null
        setSearchQuery('')
        loadFacts(workspaceId)
      }
    },
    [workspaceId]
  )

  const model = useFactsModel({
    facts,
    categories,
    tiers,
    status,
    sort,
    searchMode,
    query: debouncedQuery,
    collapsedTiers
  })

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleGroup = useCallback((tier: number) => {
    setCollapsedTiers((prev) => {
      const next = new Set(prev)
      if (next.has(tier)) next.delete(tier)
      else next.add(tier)
      return next
    })
  }, [])

  const handlers = useMemo(
    () => ({
      onConfirm: (id: string) => confirmFact(id, workspaceId),
      onArchive: (id: string) => archiveFact(id, workspaceId),
      onDelete: (id: string) => deleteFact(id),
      onScopeToggle: (fact: { id: string; workspaceId: string | null }) =>
        toggleScope(fact.id, !!fact.workspaceId, fact.workspaceId ? undefined : workspaceId),
      onScopePathsChange: (id: string, scopePaths: string[]) => updateFact(id, { scopePaths })
    }),
    [workspaceId, confirmFact, archiveFact, deleteFact, toggleScope, updateFact]
  )

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      <FactsToolbar
        query={query}
        onQueryChange={setQuery}
        searchMode={searchMode}
        onSearchModeChange={handleSearchModeChange}
        categories={categories}
        onCategoriesChange={setCategories}
        tiers={tiers}
        onTiersChange={setTiers}
        status={status}
        onStatusChange={setStatus}
        sort={sort}
        onSortChange={setSort}
        tierCounts={model.tierCounts}
        categoryCounts={model.categoryCounts}
        validatedPct={model.validatedPct}
        matchCount={model.matchCount}
        scopedCount={model.scopedCount}
        insightsOpen={insightsOpen}
        onToggleInsights={() => setInsightsOpen((v) => !v)}
      />

      {insightsOpen && (
        <div className="shrink-0 mb-3">
          <MemorySearchPlayground workspaceId={workspaceId} />
        </div>
      )}

      <FactList
        rows={model.rows}
        expandedIds={expandedIds}
        onToggleExpand={toggleExpand}
        onToggleGroup={toggleGroup}
        dimmed={status === 'superseded'}
        loading={factsLoading}
        {...handlers}
      />
    </div>
  )
}
