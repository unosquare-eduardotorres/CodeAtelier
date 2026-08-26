/**
 * The slice of the Jira panel the workspace remembers between visits.
 *
 * Without this the panel resets to `JIRA_DEFAULT_JQL` on every mount, so a user
 * who has scoped to a project and a sprint retypes it each time they come back.
 * It rides in workspace settings — a JSON blob that already exists — so there is
 * no migration and no new table.
 *
 * Everything here is parsed defensively: the settings blob is user-editable
 * state from disk, and a stale or hand-edited shape must degrade to the
 * defaults rather than take the panel down.
 */

import { JIRA_DEFAULT_JQL } from '../../../../../shared/jira.types'
import {
  JIRA_DEFAULT_SORT,
  asSortField,
  type JiraSortDir,
  type JiraSortField
} from '../../../../../shared/jira-list-view'

/** Key inside the workspace settings blob. */
export const JIRA_VIEW_STATE_KEY = 'jiraViewState'

/** A user-pinned JQL chip, shown alongside the built-in quick filters. */
export interface JiraSavedFilter {
  id: string
  label: string
  jql: string
}

/** Ceiling on pinned chips — the row has to stay a row. */
export const JIRA_MAX_SAVED_FILTERS = 12

export interface JiraViewState {
  jql: string
  sortField: JiraSortField
  sortDir: JiraSortDir
  groupByProject: boolean
  projectKey: string | null
  boardId: number | null
  sprintId: number | null
  savedFilters: JiraSavedFilter[]
}

export const JIRA_DEFAULT_VIEW_STATE: JiraViewState = {
  jql: JIRA_DEFAULT_JQL,
  sortField: JIRA_DEFAULT_SORT.field,
  sortDir: JIRA_DEFAULT_SORT.dir,
  groupByProject: false,
  projectKey: null,
  boardId: null,
  sprintId: null,
  savedFilters: []
}

function optionalText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > maxChars ? null : trimmed
}

function optionalId(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function parseSavedFilters(value: unknown): JiraSavedFilter[] {
  if (!Array.isArray(value)) return []
  const filters: JiraSavedFilter[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry as { id?: unknown; label?: unknown; jql?: unknown }
    const label = optionalText(f.label, 60)
    const jql = optionalText(f.jql, 2000)
    if (!label || !jql) continue
    filters.push({ id: optionalText(f.id, 60) ?? `${filters.length}-${label}`, label, jql })
    if (filters.length >= JIRA_MAX_SAVED_FILTERS) break
  }
  return filters
}

/** Read the persisted view out of a workspace settings blob. */
export function parseJiraViewState(settings: Record<string, unknown> | null): JiraViewState {
  const raw = settings?.[JIRA_VIEW_STATE_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...JIRA_DEFAULT_VIEW_STATE }

  const v = raw as Record<string, unknown>
  return {
    jql: optionalText(v.jql, 2000) ?? JIRA_DEFAULT_VIEW_STATE.jql,
    sortField: asSortField(v.sortField),
    sortDir: v.sortDir === 'asc' ? 'asc' : 'desc',
    groupByProject: v.groupByProject === true,
    projectKey: optionalText(v.projectKey, 60)?.toUpperCase() ?? null,
    boardId: optionalId(v.boardId),
    sprintId: optionalId(v.sprintId),
    savedFilters: parseSavedFilters(v.savedFilters)
  }
}
