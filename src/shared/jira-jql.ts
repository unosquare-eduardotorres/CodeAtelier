/**
 * JQL rewriting — pure string surgery, no Jira knowledge beyond the grammar.
 *
 * The panel's scoping controls (project, sprint, sort) all work by editing the
 * query the user can see rather than by holding hidden state next to it. That
 * matters because the JQL box stays editable: if the sort dropdown kept its own
 * `orderBy` and the box kept its own `ORDER BY`, one of them would be lying.
 *
 * Every helper is aware of quotes and parentheses, so a clause inside a quoted
 * literal (`summary ~ "order by monday"`) is never mistaken for syntax.
 */

import type { JiraSortDir, JiraSortField } from './jira-list-view'

/** JQL field name for each sortable column. Rank is capitalised by convention. */
const JQL_SORT_FIELD: Record<JiraSortField, string> = {
  updated: 'updated',
  created: 'created',
  priority: 'priority',
  status: 'status',
  key: 'key',
  assignee: 'assignee',
  rank: 'Rank'
}

/** True when position `i` starts a new word (so `border` is not read as `or`). */
function isWordStart(text: string, i: number): boolean {
  return i === 0 || !/[\w]/.test(text[i - 1])
}

/** True when the word ending at `i + length` is not glued to more word chars. */
function isWordEnd(text: string, end: number): boolean {
  return end >= text.length || !/[\w]/.test(text[end])
}

/**
 * Walk a JQL string, invoking `visit` at every top-level character.
 *
 * "Top level" means outside quotes and outside parentheses — the only place a
 * clause separator or an `ORDER BY` can legally appear.
 */
function scanTopLevel(jql: string, visit: (index: number) => number | undefined): void {
  let quote: string | null = null
  let depth = 0

  for (let i = 0; i < jql.length; i++) {
    const ch = jql[i]

    if (quote !== null) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') {
      depth++
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0) continue

    const jump = visit(i)
    if (typeof jump === 'number') i = jump
  }
}

/** Index of the top-level `ORDER BY`, or -1. */
function orderByIndex(jql: string): number {
  let found = -1
  scanTopLevel(jql, (i) => {
    if (jql[i] !== 'o' && jql[i] !== 'O') return undefined
    if (!isWordStart(jql, i)) return undefined
    const match = /^order\s+by\b/i.exec(jql.slice(i))
    if (!match) return undefined
    found = i
    return i + match[0].length - 1
  })
  return found
}

/** Everything before the top-level `ORDER BY`, trimmed. */
export function stripOrderBy(jql: string): string {
  const index = orderByIndex(jql ?? '')
  return (index < 0 ? (jql ?? '') : jql.slice(0, index)).trim()
}

/** The top-level `ORDER BY …` clause, or '' when the query has none. */
export function orderByOf(jql: string): string {
  const index = orderByIndex(jql ?? '')
  return index < 0 ? '' : jql.slice(index).trim()
}

/**
 * Set the ordering, replacing any clause already there.
 *
 * Appending would produce `ORDER BY rank ASC ORDER BY updated DESC`, which Jira
 * rejects outright — and the quick-filter chips all ship their own `ORDER BY`,
 * so this path is hit the moment anyone sorts after clicking a chip.
 */
export function applyOrderBy(jql: string, field: JiraSortField, dir: JiraSortDir): string {
  const base = stripOrderBy(jql)
  const clause = `ORDER BY ${JQL_SORT_FIELD[field]} ${dir === 'asc' ? 'ASC' : 'DESC'}`
  return base.length > 0 ? `${base} ${clause}` : clause
}

/**
 * Split a where-clause on top-level `AND`.
 *
 * Returns null when a top-level `OR` is present: `A OR B` cannot be treated as
 * a list of independently removable clauses, and dropping a branch of it would
 * quietly change which issues the query means.
 */
function splitTopLevelAnd(where: string): string[] | null {
  const segments: string[] = []
  let start = 0
  let hasOr = false

  scanTopLevel(where, (i) => {
    if (!isWordStart(where, i)) return undefined

    if (/^and\b/i.test(where.slice(i)) && isWordEnd(where, i + 3)) {
      segments.push(where.slice(start, i))
      start = i + 3
      return start - 1
    }
    if (/^or\b/i.test(where.slice(i)) && isWordEnd(where, i + 2)) {
      hasOr = true
    }
    return undefined
  })

  if (hasOr) return null
  segments.push(where.slice(start))
  return segments.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
}

/** Lowercased field name a clause tests, e.g. `project = "CHR"` → `project`. */
function fieldOf(clause: string): string {
  const match = /^\s*(?:not\s+)?"?([A-Za-z_][\w]*)"?/.exec(clause)
  return match ? match[1].toLowerCase() : ''
}

/**
 * Replace whatever the query said about `field` with `clause`.
 *
 * `clause` of null removes the scope without adding one. The existing
 * `ORDER BY` is carried across untouched — scoping is not sorting.
 */
function applyScope(jql: string, field: string, clause: string | null): string {
  const order = orderByOf(jql ?? '')
  const where = stripOrderBy(jql ?? '')
  const segments = splitTopLevelAnd(where)

  const base =
    segments === null
      ? // Top-level OR — keep the user's query whole and parenthesised so the
        // new scope narrows it rather than mangling it.
        where.length > 0
        ? `(${where})`
        : ''
      : segments.filter((segment) => fieldOf(segment) !== field).join(' AND ')

  const composed = [clause, base].filter((part): part is string => !!part && part.length > 0)
  return [composed.join(' AND '), order].filter((part) => part.length > 0).join(' ')
}

/**
 * Scope a query to one project, or clear the scope with null.
 *
 * The key is sanitised to the characters Jira allows in one, so this cannot be
 * used to smuggle a second clause in through the project dropdown.
 */
export function applyProjectScope(jql: string, projectKey: string | null): string {
  const safe = (projectKey ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '')
  return applyScope(jql, 'project', safe.length > 0 ? `project = "${safe}"` : null)
}

/**
 * Scope a query to one sprint, or clear the scope with null.
 *
 * Also removes `sprint in openSprints()` — the "My current sprint" chip ships
 * exactly that, and leaving it in would AND two sprint constraints together and
 * return nothing.
 */
export function applySprintScope(jql: string, sprintId: string | number | null): string {
  const safe = String(sprintId ?? '').replace(/[^0-9]/g, '')
  return applyScope(jql, 'sprint', safe.length > 0 ? `sprint = ${safe}` : null)
}

/**
 * Project key a query is already scoped to, or null.
 *
 * Lets the dropdown stay honest when the user edits the JQL by hand instead of
 * showing a selection the query no longer carries. Only a single-value
 * `project = X` counts; `project in (A, B)` is not one project.
 */
export function readProjectScope(jql: string): string | null {
  const segments = splitTopLevelAnd(stripOrderBy(jql ?? ''))
  if (segments === null) return null
  for (const segment of segments) {
    if (fieldOf(segment) !== 'project') continue
    const match = /^\s*"?project"?\s*=\s*"?([A-Za-z0-9_]+)"?\s*$/.exec(segment)
    if (match) return match[1].toUpperCase()
  }
  return null
}

/** Sprint id a query is already scoped to, or null. */
export function readSprintScope(jql: string): string | null {
  const segments = splitTopLevelAnd(stripOrderBy(jql ?? ''))
  if (segments === null) return null
  for (const segment of segments) {
    if (fieldOf(segment) !== 'sprint') continue
    const match = /^\s*"?sprint"?\s*=\s*(\d+)\s*$/.exec(segment)
    if (match) return match[1]
  }
  return null
}
