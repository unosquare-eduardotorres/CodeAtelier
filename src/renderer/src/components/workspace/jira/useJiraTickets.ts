import { useCallback, useEffect, useRef, useState } from 'react'
import type { JiraIssueRow, JiraSearchResult } from '../../../../../shared/jira.types'
import { JIRA_DEFAULT_JQL } from '../../../../../shared/jira.types'

interface UseJiraTickets {
  jql: string
  setJql: (jql: string) => void
  issues: JiraIssueRow[]
  result: JiraSearchResult | null
  isLoading: boolean
  /** User-facing message from the last failed search, or null. */
  error: string | null
  /** True once a search has completed (success or failure) — gates the empty state. */
  hasSearched: boolean
  search: (jql?: string) => Promise<void>
  /** Key of the ticket shown in the detail pane, or null. */
  activeKey: string | null
  setActiveKey: (key: string | null) => void
  selectedKeys: Set<string>
  toggleSelected: (key: string) => void
  /** Drop specific keys — used to retire tickets that converted successfully. */
  deselect: (keys: string[]) => void
  selectAll: () => void
  clearSelection: () => void
}

/**
 * JQL search + row selection for the Jira tickets panel.
 *
 * Selection is intersected with the current result set on every search: a key
 * selected in a previous query that the new query does not return would
 * otherwise stay silently checked and end up in a bulk conversion the user
 * cannot see on screen. The open detail pane is dropped on the same rule, so it
 * cannot outlive the row it belongs to.
 */
export function useJiraTickets(workspaceId: string | null, enabled: boolean): UseJiraTickets {
  const [jql, setJql] = useState(JIRA_DEFAULT_JQL)
  const [result, setResult] = useState<JiraSearchResult | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasSearched, setHasSearched] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [activeKey, setActiveKey] = useState<string | null>(null)

  // Guards against a slow earlier search resolving after a newer one and
  // overwriting the fresher result.
  const requestSeq = useRef(0)

  const search = useCallback(
    async (overrideJql?: string): Promise<void> => {
      if (!workspaceId) return
      const query = (overrideJql ?? jql).trim()
      if (query.length === 0) return

      const seq = ++requestSeq.current
      setIsLoading(true)
      setError(null)
      try {
        const next = await window.api.jiraSearchIssues({ workspaceId, jql: query, maxResults: 50 })
        if (seq !== requestSeq.current) return
        setResult(next)
        const visible = new Set(next.issues.map((i) => i.key))
        setSelectedKeys((prev) => new Set([...prev].filter((key) => visible.has(key))))
        setActiveKey((prev) => (prev !== null && visible.has(prev) ? prev : null))
      } catch (err) {
        if (seq !== requestSeq.current) return
        setResult(null)
        setSelectedKeys(new Set())
        setActiveKey(null)
        setError(err instanceof Error ? err.message : 'Jira search failed.')
      } finally {
        if (seq === requestSeq.current) {
          setIsLoading(false)
          setHasSearched(true)
        }
      }
    },
    [workspaceId, jql]
  )

  // Initial load, and a reload when the workspace connects Jira. `search` is
  // deliberately not a dependency — it changes on every keystroke in the JQL
  // box, which would re-fire the query while the user is still typing. The ref
  // is written in its own effect rather than during render.
  const searchRef = useRef(search)
  useEffect(() => {
    searchRef.current = search
  }, [search])

  useEffect(() => {
    if (!workspaceId || !enabled) return
    void searchRef.current()
  }, [workspaceId, enabled])

  const toggleSelected = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
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

  const selectAll = useCallback(() => {
    setSelectedKeys(new Set((result?.issues ?? []).map((i) => i.key)))
  }, [result])

  const clearSelection = useCallback(() => setSelectedKeys(new Set()), [])

  return {
    jql,
    setJql,
    issues: result?.issues ?? [],
    result,
    isLoading,
    error,
    hasSearched,
    search,
    activeKey,
    setActiveKey,
    selectedKeys,
    toggleSelected,
    deselect,
    selectAll,
    clearSelection
  }
}
