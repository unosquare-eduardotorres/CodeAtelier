/**
 * Pure view-model helpers for the Jira tickets list.
 *
 * The panel used to render `result.issues` verbatim, which meant the list was
 * whatever order Jira happened to return, unfiltered and ungrouped. Filtering,
 * sorting and grouping live here rather than in the hook so they are testable
 * without React — there is no renderer unit harness in this repo.
 *
 * Dependency-free on purpose: imported by the renderer and by the main-process
 * tests alike.
 */

import type { JiraIssueRow } from './jira.types'

/** Fields the list can be ordered by. */
export const JIRA_SORT_FIELDS = [
  'updated',
  'created',
  'priority',
  'status',
  'key',
  'assignee',
  'rank'
] as const

export type JiraSortField = (typeof JIRA_SORT_FIELDS)[number]
export type JiraSortDir = 'asc' | 'desc'

export const JIRA_SORT_LABELS: Record<JiraSortField, string> = {
  updated: 'Updated',
  created: 'Created',
  priority: 'Priority',
  status: 'Status',
  key: 'Key',
  assignee: 'Assignee',
  rank: 'Rank'
}

/**
 * Sort fields with no corresponding column on `JiraIssueRow`.
 *
 * Rank is a per-instance custom field that never appears in a search response,
 * so there is nothing local to compare. Ordering by it is only meaningful as a
 * JQL `ORDER BY Rank`, which is why `sortIssues` leaves the rows in the order
 * Jira returned them for this field rather than inventing one.
 */
export const JIRA_SERVER_ONLY_SORT_FIELDS: readonly JiraSortField[] = ['rank']

/** Default ordering — newest activity first, matching `JIRA_DEFAULT_JQL`. */
export const JIRA_DEFAULT_SORT: { field: JiraSortField; dir: JiraSortDir } = {
  field: 'updated',
  dir: 'desc'
}

/** Narrow an arbitrary string to a sort field, falling back to the default. */
export function asSortField(value: unknown): JiraSortField {
  return JIRA_SORT_FIELDS.includes(value as JiraSortField)
    ? (value as JiraSortField)
    : JIRA_DEFAULT_SORT.field
}

// ── Project keys ──

/**
 * Project key an issue key belongs to: `CHR-40` → `CHR`, `AB1_C-9` → `AB1_C`.
 *
 * Free of any REST call — which is the whole reason grouping and the project
 * chips need no extra round trip. A key that does not end in `-<digits>` is
 * returned as-is rather than throwing, so a malformed row still lands in a
 * bucket instead of taking the list down.
 */
export function projectKeyOf(issueKey: string): string {
  const trimmed = (issueKey ?? '').trim()
  const match = /^(.+)-\d+$/.exec(trimmed)
  return (match ? match[1] : trimmed).toUpperCase()
}

/** Issue number, used to order `CHR-9` before `CHR-10`. */
function issueNumberOf(issueKey: string): number {
  const match = /-(\d+)$/.exec((issueKey ?? '').trim())
  return match ? Number(match[1]) : 0
}

/** Unique project keys present in a result set, alphabetically. */
export function projectKeysOf(rows: readonly JiraIssueRow[]): string[] {
  const keys = new Set<string>()
  for (const row of rows) {
    const project = projectKeyOf(row.key)
    if (project.length > 0) keys.add(project)
  }
  return [...keys].sort()
}

// ── Filtering ──

/**
 * Lowercase alphanumerics only.
 *
 * Both sides of the comparison go through this, which is what makes `CHR2`
 * match `CHR-240` and `in progress` match the status `In Progress` — the
 * punctuation a user does not type is not part of the comparison.
 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Free-text filter over the loaded rows.
 *
 * Space-separated terms are ANDed across key, summary, assignee, status and
 * type, so `chr bug josh` narrows on three different fields at once. A filter
 * that normalises to nothing (all punctuation) matches everything rather than
 * matching nothing — an empty list would look like a failed query.
 *
 * This filters *loaded* rows only. It is not a substitute for narrowing the
 * JQL, and the panel says so when more pages exist.
 */
export function filterIssues(rows: readonly JiraIssueRow[], text: string): JiraIssueRow[] {
  const terms = (text ?? '')
    .split(/\s+/)
    .map(normalize)
    .filter((term) => term.length > 0)
  if (terms.length === 0) return [...rows]

  return rows.filter((row) => {
    const haystack = normalize(
      [row.key, row.summary, row.assignee, row.status, row.type].filter(Boolean).join(' ')
    )
    return terms.every((term) => haystack.includes(term))
  })
}

// ── Sorting ──

/**
 * Priority name → importance, where a larger number is more urgent.
 *
 * `mapJiraPriority` in `jira-format.ts` collapses everything onto P1–P3, which
 * would sort Lowest equal to Medium — fine for a blueprint's priority field,
 * wrong for an ordering. Names come from Jira's default scheme plus the Bug
 * scheme (Blocker / Critical / Major / Trivial) that most instances also carry.
 */
const PRIORITY_IMPORTANCE: Readonly<Record<string, number>> = {
  highest: 5,
  blocker: 5,
  critical: 5,
  p1: 5,
  high: 4,
  major: 4,
  p2: 4,
  medium: 3,
  normal: 3,
  p3: 3,
  low: 2,
  minor: 2,
  p4: 2,
  lowest: 1,
  trivial: 1,
  p5: 1
}

/** Importance of a priority name, or null when the scheme is unrecognised. */
export function priorityImportance(priority: string | undefined): number | null {
  const name = (priority ?? '').trim().toLowerCase()
  return PRIORITY_IMPORTANCE[name] ?? null
}

/**
 * Ordering for rows where one side has no value.
 *
 * Missing values sort last in *both* directions: an unprioritised ticket at the
 * top of a "least urgent first" list is noise, not information. Returns null
 * when both sides have a value and the real comparator should run.
 */
function missingLast(a: unknown, b: unknown): number | null {
  const aMissing = a === null || a === undefined
  const bMissing = b === null || b === undefined
  if (aMissing && bMissing) return 0
  if (aMissing) return 1
  if (bMissing) return -1
  return null
}

/** Epoch millis, or null for an absent or unparseable timestamp. */
function timeOf(iso: string | undefined): number | null {
  if (!iso) return null
  const time = new Date(iso).getTime()
  return Number.isNaN(time) ? null : time
}

function textKeyOf(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length === 0 ? null : trimmed.toLowerCase()
}

/**
 * Order rows by one field.
 *
 * `asc` is the field's natural ascending order; for priority that is
 * least-urgent-first, so `desc` puts the P1s at the top — which is what
 * "Priority, descending" means to anyone reading a board.
 *
 * Ties keep their input order (Array.prototype.sort is stable), so re-sorting
 * a grouped list does not shuffle rows that compare equal.
 */
export function sortIssues(
  rows: readonly JiraIssueRow[],
  field: JiraSortField,
  dir: JiraSortDir
): JiraIssueRow[] {
  const sorted = [...rows]

  // No local column to compare — Jira's own ordering is the answer, and
  // fabricating one here would silently disagree with `ORDER BY Rank`.
  if (JIRA_SERVER_ONLY_SORT_FIELDS.includes(field)) return sorted

  const sign = dir === 'asc' ? 1 : -1

  sorted.sort((a, b) => {
    switch (field) {
      case 'priority': {
        const left = priorityImportance(a.priority)
        const right = priorityImportance(b.priority)
        const missing = missingLast(left, right)
        return missing ?? (left! - right!) * sign
      }
      case 'created':
      case 'updated': {
        const left = timeOf(field === 'created' ? a.created : a.updated)
        const right = timeOf(field === 'created' ? b.created : b.updated)
        const missing = missingLast(left, right)
        return missing ?? (left! - right!) * sign
      }
      case 'status':
      case 'assignee': {
        const left = textKeyOf(field === 'status' ? a.status : a.assignee)
        const right = textKeyOf(field === 'status' ? b.status : b.assignee)
        const missing = missingLast(left, right)
        return missing ?? left!.localeCompare(right!) * sign
      }
      default: {
        const project = projectKeyOf(a.key).localeCompare(projectKeyOf(b.key))
        if (project !== 0) return project * sign
        return (issueNumberOf(a.key) - issueNumberOf(b.key)) * sign
      }
    }
  })

  return sorted
}

// ── Grouping ──

export interface JiraProjectGroup {
  project: string
  rows: JiraIssueRow[]
}

/**
 * Bucket rows by project key, preserving both the order projects first appear
 * in and the row order inside each bucket — so grouping a sorted list keeps the
 * sort, and grouping an unsorted one keeps Jira's ranking.
 */
export function groupByProject(rows: readonly JiraIssueRow[]): JiraProjectGroup[] {
  const groups = new Map<string, JiraIssueRow[]>()
  for (const row of rows) {
    const project = projectKeyOf(row.key)
    const bucket = groups.get(project)
    if (bucket) bucket.push(row)
    else groups.set(project, [row])
  }
  return [...groups.entries()].map(([project, grouped]) => ({ project, rows: grouped }))
}
