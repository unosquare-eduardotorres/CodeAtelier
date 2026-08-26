import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  JiraBoard,
  JiraIssueRow,
  JiraProject,
  JiraSearchResult,
  JiraSprint
} from '../../../../../shared/jira.types'
import { JIRA_MAX_BULK_ISSUES, JIRA_MAX_LOADED_ROWS } from '../../../../../shared/jira.types'
import {
  filterIssues,
  groupByProject as groupRows,
  projectKeysOf,
  sortIssues,
  type JiraProjectGroup,
  type JiraSortDir,
  type JiraSortField
} from '../../../../../shared/jira-list-view'
import {
  applyOrderBy,
  applyProjectScope,
  applySprintScope,
  orderByOf
} from '../../../../../shared/jira-jql'
import {
  JIRA_MAX_SAVED_FILTERS,
  JIRA_VIEW_STATE_KEY,
  parseJiraViewState,
  type JiraSavedFilter,
  type JiraViewState
} from './jira-view-state'

/** One page. Jira Cloud's `/search/jql` caps a page at 100; the service caps at 50. */
const PAGE_SIZE = 50

/** Debounce before writing the view back to workspace settings. */
const PERSIST_DELAY_MS = 600

export interface UseJiraTickets {
  jql: string
  setJql: (jql: string) => void

  /** Every row loaded so far, across all pages, in Jira's order. */
  issues: JiraIssueRow[]
  /** Rows after filter + sort — what the list actually renders. */
  visibleIssues: JiraIssueRow[]
  /** `visibleIssues` bucketed by project, or null when grouping is off. */
  groups: JiraProjectGroup[] | null

  result: JiraSearchResult | null
  isLoading: boolean
  isLoadingMore: boolean
  /** User-facing message from the last failed search, or null. */
  error: string | null
  /** True once a search has completed (success or failure) — gates the empty state. */
  hasSearched: boolean
  /** When the loaded rows were fetched, for the "as of" label. */
  fetchedAt: number | null

  search: (jql?: string) => Promise<void>
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  /** True when another page exists and the row ceiling has not been hit. */
  canLoadMore: boolean
  /** True when the loaded rows are the entire result set. */
  isComplete: boolean

  filterText: string
  setFilterText: (text: string) => void
  sortField: JiraSortField
  sortDir: JiraSortDir
  setSort: (field: JiraSortField, dir: JiraSortDir) => void
  /** True when the current ordering was answered by Jira, not applied locally. */
  isServerSorted: boolean
  grouped: boolean
  setGrouped: (grouped: boolean) => void

  projects: JiraProject[]
  projectKey: string | null
  selectProject: (key: string | null) => void
  boards: JiraBoard[]
  boardId: number | null
  selectBoard: (id: number | null) => void
  sprints: JiraSprint[]
  sprintId: number | null
  selectSprint: (id: number | null) => void

  savedFilters: JiraSavedFilter[]
  saveCurrentFilter: (label: string) => void
  removeSavedFilter: (id: string) => void

  /** issueKey → blueprint id for tickets already converted in this workspace. */
  convertedKeys: Record<string, string>
  reloadConverted: () => Promise<void>

  /** Key of the ticket shown in the detail pane, or null. */
  activeKey: string | null
  setActiveKey: (key: string | null) => void
  /** Row the keyboard is on. */
  cursorKey: string | null
  setCursorKey: (key: string | null) => void
  moveCursor: (delta: number) => void

  selectedKeys: Set<string>
  toggleSelected: (key: string) => void
  /** Drop specific keys — used to retire tickets that converted successfully. */
  deselect: (keys: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  /** True when the selection has hit the bulk-convert ceiling. */
  selectionAtCap: boolean
}

/**
 * Append a page without duplicating rows.
 *
 * Jira paginates over live data, so an issue updated between two requests can
 * legitimately arrive on both pages. The ceiling is enforced here rather than
 * at the call site so no path can grow the list past it.
 */
function mergeRows(prev: JiraIssueRow[], next: readonly JiraIssueRow[]): JiraIssueRow[] {
  const seen = new Set(prev.map((row) => row.key))
  const merged = [...prev]
  for (const row of next) {
    if (seen.has(row.key)) continue
    seen.add(row.key)
    merged.push(row)
  }
  return merged.slice(0, JIRA_MAX_LOADED_ROWS)
}

/**
 * JQL search, paging, view state and row selection for the Jira tickets panel.
 *
 * Two rules shape this hook:
 *
 * 1. **A new search intersects the selection with the result set; appending a
 *    page does not.** A key selected by a previous *query* that the new one does
 *    not return would otherwise stay silently ticked and end up in a bulk
 *    conversion the user cannot see. Rows from an earlier *page* of the same
 *    query are still on screen, so intersecting there would unselect work the
 *    user just did.
 *
 * 2. **Sorting is local only when the loaded rows are the whole result set.**
 *    Ordering 50 of 1,240 rows and presenting it as the ranking is a lie, so
 *    when more pages exist the ordering is pushed into the JQL and Jira answers
 *    it — see `setSort`.
 */
export function useJiraTickets(workspaceId: string | null, enabled: boolean): UseJiraTickets {
  const [view, setView] = useState<JiraViewState>(() => parseJiraViewState(null))
  // The workspace whose persisted view has been read, rather than a boolean —
  // deriving "is this workspace hydrated?" removes the synchronous reset that a
  // boolean would need on every workspace switch.
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)
  const hydrated = workspaceId !== null && hydratedFor === workspaceId

  const [rows, setRows] = useState<JiraIssueRow[]>([])
  const [result, setResult] = useState<JiraSearchResult | null>(null)
  const [lastSearchedJql, setLastSearchedJql] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)

  const [filterText, setFilterText] = useState('')
  const [projects, setProjects] = useState<JiraProject[]>([])
  // Board and sprint lists are stamped with the scope they were fetched for, so
  // project A's boards can never be shown for project B while B's are in flight.
  const [boardsFor, setBoardsFor] = useState<{ projectKey: string; boards: JiraBoard[] } | null>(
    null
  )
  const [sprintsFor, setSprintsFor] = useState<{ boardId: number; sprints: JiraSprint[] } | null>(
    null
  )
  const [convertedKeys, setConvertedKeys] = useState<Record<string, string>>({})

  const boards =
    boardsFor !== null && boardsFor.projectKey === view.projectKey ? boardsFor.boards : []
  const sprints =
    sprintsFor !== null && sprintsFor.boardId === view.boardId ? sprintsFor.sprints : []

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [cursorKey, setCursorKey] = useState<string | null>(null)

  // Guards against a slow earlier search resolving after a newer one and
  // overwriting the fresher result.
  const requestSeq = useRef(0)
  // Read inside callbacks that must not re-create on every keystroke.
  const jqlRef = useRef(view.jql)
  useEffect(() => {
    jqlRef.current = view.jql
  }, [view.jql])

  const patchView = useCallback((patch: Partial<JiraViewState>) => {
    setView((prev) => ({ ...prev, ...patch }))
  }, [])

  const setJql = useCallback(
    (jql: string) => {
      jqlRef.current = jql
      patchView({ jql })
    },
    [patchView]
  )

  // ── Searching ──

  const runSearch = useCallback(
    async (query: string, cursor?: string): Promise<void> => {
      if (!workspaceId) return
      const trimmed = query.trim()
      if (trimmed.length === 0) return

      const appending = cursor !== undefined
      const seq = ++requestSeq.current
      if (appending) setIsLoadingMore(true)
      else setIsLoading(true)
      setError(null)

      try {
        const next = await window.api.jiraSearchIssues({
          workspaceId,
          jql: trimmed,
          maxResults: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor })
        })
        if (seq !== requestSeq.current) return

        setResult(next)
        setLastSearchedJql(trimmed)
        setFetchedAt(Date.now())

        if (appending) {
          setRows((prev) => mergeRows(prev, next.issues))
          return
        }

        setRows(next.issues)
        const visible = new Set(next.issues.map((issue) => issue.key))
        setSelectedKeys((prev) => new Set([...prev].filter((key) => visible.has(key))))
        setActiveKey((prev) => (prev !== null && visible.has(prev) ? prev : null))
        setCursorKey((prev) => (prev !== null && visible.has(prev) ? prev : null))
      } catch (err) {
        if (seq !== requestSeq.current) return
        if (!appending) {
          setResult(null)
          setRows([])
          setSelectedKeys(new Set())
          setActiveKey(null)
          setCursorKey(null)
        }
        setError(err instanceof Error ? err.message : 'Jira search failed.')
      } finally {
        if (seq === requestSeq.current) {
          setIsLoading(false)
          setIsLoadingMore(false)
          setHasSearched(true)
        }
      }
    },
    [workspaceId]
  )

  const search = useCallback(
    (overrideJql?: string): Promise<void> => runSearch(overrideJql ?? jqlRef.current),
    [runSearch]
  )

  const refresh = useCallback((): Promise<void> => runSearch(jqlRef.current), [runSearch])

  const canLoadMore =
    typeof result?.nextCursor === 'string' && rows.length < JIRA_MAX_LOADED_ROWS && !isLoadingMore

  const loadMore = useCallback(async (): Promise<void> => {
    const cursor = result?.nextCursor
    if (!cursor || rows.length >= JIRA_MAX_LOADED_ROWS) return
    await runSearch(lastSearchedJql ?? jqlRef.current, cursor)
  }, [result, rows.length, lastSearchedJql, runSearch])

  /** True when there is nothing left to fetch, so a local sort ranks everything. */
  const isComplete = hasSearched && !result?.nextCursor && result?.hasMore !== true

  // ── Hydration: restore the persisted view, then run the first search ──

  /** Workspace the initial search has already fired for. */
  const searchedFor = useRef<string | null>(null)

  useEffect(() => {
    if (!workspaceId) return

    let cancelled = false
    window.api
      .getWorkspaceSettings({ workspaceId })
      .then((settings) => {
        if (cancelled) return
        const restored = parseJiraViewState(settings)
        jqlRef.current = restored.jql
        setView(restored)
      })
      .catch((err) => console.warn('[useJiraTickets] Non-fatal: view state load failed:', err))
      .finally(() => {
        // Marked hydrated even on failure: a settings read that fails must not
        // leave the panel permanently refusing to run its first search.
        if (!cancelled) setHydratedFor(workspaceId)
      })

    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // The first search waits for hydration so the panel does not query with the
  // default JQL and then immediately re-query with the restored one.
  const runSearchRef = useRef(runSearch)
  useEffect(() => {
    runSearchRef.current = runSearch
  }, [runSearch])

  useEffect(() => {
    if (!workspaceId || !enabled || !hydrated) return
    if (searchedFor.current === workspaceId) return
    searchedFor.current = workspaceId
    void runSearchRef.current(jqlRef.current)
  }, [workspaceId, enabled, hydrated])

  // ── Persistence ──

  useEffect(() => {
    if (!workspaceId || !hydrated) return
    const timer = setTimeout(() => {
      window.api
        .updateWorkspaceSettings({ workspaceId, settings: { [JIRA_VIEW_STATE_KEY]: view } })
        .catch((err) => console.warn('[useJiraTickets] Non-fatal: view state save failed:', err))
    }, PERSIST_DELAY_MS)
    return () => clearTimeout(timer)
  }, [workspaceId, hydrated, view])

  // ── Reference data ──

  useEffect(() => {
    if (!workspaceId || !enabled) return
    window.api
      .jiraListProjects({ workspaceId })
      .then(setProjects)
      // A site that will not list projects is not a broken panel — the dropdown
      // falls back to the project keys present in the current result set.
      .catch((err) => console.warn('[useJiraTickets] Non-fatal: project list failed:', err))
  }, [workspaceId, enabled])

  useEffect(() => {
    const projectKey = view.projectKey
    if (!workspaceId || !enabled || !projectKey) return
    let cancelled = false
    window.api
      .jiraListBoards({ workspaceId, projectKey })
      .then((next) => {
        if (!cancelled) setBoardsFor({ projectKey, boards: next })
      })
      // The service already returns [] where the Agile API is absent; this only
      // catches a genuine transport failure, which hides the control the same way.
      .catch(() => {
        if (!cancelled) setBoardsFor({ projectKey, boards: [] })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, enabled, view.projectKey])

  useEffect(() => {
    const boardId = view.boardId
    if (!workspaceId || !enabled || boardId === null) return
    let cancelled = false
    window.api
      .jiraListSprints({ workspaceId, boardId })
      .then((next) => {
        if (!cancelled) setSprintsFor({ boardId, sprints: next })
      })
      .catch(() => {
        if (!cancelled) setSprintsFor({ boardId, sprints: [] })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, enabled, view.boardId])

  const reloadConverted = useCallback(async (): Promise<void> => {
    if (!workspaceId) return
    try {
      setConvertedKeys(await window.api.jiraConvertedKeys({ workspaceId }))
    } catch (err) {
      console.warn('[useJiraTickets] Non-fatal: converted-key lookup failed:', err)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!enabled || !workspaceId) return
    let cancelled = false
    window.api
      .jiraConvertedKeys({ workspaceId })
      .then((next) => {
        if (!cancelled) setConvertedKeys(next)
      })
      .catch((err) => console.warn('[useJiraTickets] Non-fatal: converted-key lookup failed:', err))
    return () => {
      cancelled = true
    }
  }, [enabled, workspaceId])

  // ── Derived view ──

  const visibleIssues = useMemo(
    () => sortIssues(filterIssues(rows, filterText), view.sortField, view.sortDir),
    [rows, filterText, view.sortField, view.sortDir]
  )

  const groups = useMemo(
    () => (view.groupByProject ? groupRows(visibleIssues) : null),
    [view.groupByProject, visibleIssues]
  )

  // A project you can see in the list is always selectable, even when the REST
  // project list paginated past it.
  const mergedProjects = useMemo(() => {
    const byKey = new Map(projects.map((project) => [project.key, project]))
    for (const key of projectKeysOf(rows)) {
      if (!byKey.has(key)) byKey.set(key, { id: key, key, name: key })
    }
    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  }, [projects, rows])

  const isServerSorted =
    lastSearchedJql !== null &&
    orderByOf(lastSearchedJql).toLowerCase() ===
      applyOrderBy('', view.sortField, view.sortDir).toLowerCase()

  // ── Controls ──

  /**
   * Change the ordering.
   *
   * When the whole result set is loaded this is instant and local. When more
   * pages exist a local sort would rank a slice, so the ordering is written into
   * the JQL — replacing whatever `ORDER BY` a quick-filter chip put there — and
   * the query re-runs so Jira does the ranking.
   */
  const setSort = useCallback(
    (field: JiraSortField, dir: JiraSortDir) => {
      patchView({ sortField: field, sortDir: dir })
      if (isComplete) return
      const next = applyOrderBy(jqlRef.current, field, dir)
      setJql(next)
      void runSearch(next)
    },
    [patchView, isComplete, setJql, runSearch]
  )

  const setGrouped = useCallback(
    (grouped: boolean) => patchView({ groupByProject: grouped }),
    [patchView]
  )

  const selectProject = useCallback(
    (key: string | null) => {
      const next = applyProjectScope(jqlRef.current, key)
      patchView({ projectKey: key, boardId: null, sprintId: null, jql: next })
      jqlRef.current = next
      void runSearch(next)
    },
    [patchView, runSearch]
  )

  const selectBoard = useCallback(
    (id: number | null) => {
      // A board carries no JQL of its own — its project already scoped the
      // query. Picking one only changes which sprints are offered, so the sole
      // query edit is dropping whatever sprint clause was there.
      const next = applySprintScope(jqlRef.current, null)
      patchView({ boardId: id, sprintId: null, jql: next })
      jqlRef.current = next
      void runSearch(next)
    },
    [patchView, runSearch]
  )

  const selectSprint = useCallback(
    (id: number | null) => {
      const next = applySprintScope(jqlRef.current, id)
      patchView({ sprintId: id, jql: next })
      jqlRef.current = next
      void runSearch(next)
    },
    [patchView, runSearch]
  )

  const saveCurrentFilter = useCallback((label: string) => {
    const trimmed = label.trim()
    if (trimmed.length === 0) return
    setView((prev) =>
      prev.savedFilters.length >= JIRA_MAX_SAVED_FILTERS
        ? prev
        : {
            ...prev,
            savedFilters: [
              ...prev.savedFilters,
              { id: `${Date.now()}`, label: trimmed.slice(0, 60), jql: prev.jql }
            ]
          }
    )
  }, [])

  const removeSavedFilter = useCallback((id: string) => {
    setView((prev) => ({
      ...prev,
      savedFilters: prev.savedFilters.filter((filter) => filter.id !== id)
    }))
  }, [])

  // ── Selection ──

  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      // Capped rather than left to fail at the IPC boundary: the bulk convert
      // costs one Jira round trip per ticket, and the toolbar says so.
      else if (next.size < JIRA_MAX_BULK_ISSUES) next.add(key)
      return next
    })
  }, [])

  // Subtractive rather than a toggle per key: if the user unticks a row while a
  // bulk conversion is in flight, toggling the converted keys back would re-tick
  // it and offer to convert it a second time.
  const deselect = useCallback((keys: string[]) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      for (const key of keys) next.delete(key)
      return next
    })
  }, [])

  /** Select what is on screen, skipping tickets that already have a blueprint. */
  const selectAll = useCallback(() => {
    const eligible = visibleIssues
      .filter((issue) => convertedKeys[issue.key] === undefined)
      .slice(0, JIRA_MAX_BULK_ISSUES)
      .map((issue) => issue.key)
    setSelectedKeys(new Set(eligible))
  }, [visibleIssues, convertedKeys])

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), [])

  const moveCursor = useCallback(
    (delta: number) => {
      if (visibleIssues.length === 0) return
      setCursorKey((prev) => {
        const index = prev === null ? -1 : visibleIssues.findIndex((issue) => issue.key === prev)
        const next = Math.min(Math.max(index + delta, 0), visibleIssues.length - 1)
        return visibleIssues[next].key
      })
    },
    [visibleIssues]
  )

  return {
    jql: view.jql,
    setJql,
    issues: rows,
    visibleIssues,
    groups,
    result,
    isLoading,
    isLoadingMore,
    error,
    hasSearched,
    fetchedAt,
    search,
    refresh,
    loadMore,
    canLoadMore,
    isComplete,
    filterText,
    setFilterText,
    sortField: view.sortField,
    sortDir: view.sortDir,
    setSort,
    isServerSorted,
    grouped: view.groupByProject,
    setGrouped,
    projects: mergedProjects,
    projectKey: view.projectKey,
    selectProject,
    boards,
    boardId: view.boardId,
    selectBoard,
    sprints,
    sprintId: view.sprintId,
    selectSprint,
    savedFilters: view.savedFilters,
    saveCurrentFilter,
    removeSavedFilter,
    convertedKeys,
    reloadConverted,
    activeKey,
    setActiveKey,
    cursorKey,
    setCursorKey,
    moveCursor,
    selectedKeys,
    toggleSelected,
    deselect,
    selectAll,
    clearSelection,
    selectionAtCap: selectedKeys.size >= JIRA_MAX_BULK_ISSUES
  }
}
