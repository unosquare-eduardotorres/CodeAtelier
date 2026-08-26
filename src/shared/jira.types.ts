/**
 * Shapes exchanged between the Jira tickets panel (renderer) and the
 * main-process Jira REST service.
 *
 * These mirror what `formatSearchRows` / `formatIssue` in
 * `main/mcp-servers/jira-api.ts` already produce for the MCP server, so both
 * surfaces read the same picture of an issue. Dependency-free on purpose — the
 * renderer imports this file directly.
 */

/**
 * One row of a JQL result set — everything the ticket list renders.
 *
 * `status` and `type` are optional because Jira omits a field entirely when the
 * account cannot see it; the list renders a fallback rather than "undefined".
 * `assignee` is always present — the formatter substitutes "Unassigned".
 */
export interface JiraIssueRow {
  key: string
  summary: string
  status?: string
  type?: string
  assignee: string
  /** ISO timestamp from Jira */
  updated?: string
}

/** A single comment on an issue, flattened to plain text. */
export interface JiraComment {
  author: string
  created?: string
  body: string
}

/**
 * One file attached to an issue.
 *
 * `contentUrl` requires the same auth headers as the issue fetch — it is a
 * main-process download handle, never something to hand to the renderer or a
 * model as a link.
 */
export interface JiraAttachment {
  id: string
  filename: string
  mimeType?: string
  /** Bytes, as reported by Jira. */
  size?: number
  contentUrl: string
}

/** Full issue detail — the shape `formatIssue` returns. */
export interface JiraIssueDetail {
  key: string
  summary: string
  type?: string
  status?: string
  priority?: string
  assignee: string
  reporter?: string
  labels: string[]
  parent?: string
  resolution?: string
  created?: string
  updated?: string
  description: string
  comments: JiraComment[]
  attachments: JiraAttachment[]
  /** Deep link into the Jira web UI, e.g. https://acme.atlassian.net/browse/PROJ-1 */
  browseUrl: string
}

/**
 * Result of a JQL search.
 *
 * `total` is absent on Jira Cloud — `GET /search/jql` paginates with
 * `nextPageToken` and returns no count. `hasMore` carries that signal instead,
 * so the panel can say "showing first N" rather than inventing a total.
 */
export interface JiraSearchResult {
  issues: JiraIssueRow[]
  count: number
  total?: number
  hasMore?: boolean
}

/** Per-ticket outcome of a bulk convert-to-blueprint run. */
export interface JiraBlueprintConversion {
  issueKey: string
  blueprintId: string
  title: string
}

export interface JiraConversionFailure {
  issueKey: string
  error: string
}

/** A ticket that already had a blueprint, so no second one was created. */
export interface JiraConversionSkip {
  issueKey: string
  blueprintId: string
}

export interface JiraCreateBlueprintsResult {
  created: JiraBlueprintConversion[]
  failed: JiraConversionFailure[]
  /** Skipped as already converted — reported so the dedupe is visible, not silent. */
  skipped: JiraConversionSkip[]
}

/**
 * A saved JQL shortcut shown as a filter chip above the ticket list.
 * `currentUser()` resolves server-side, so these work for any account.
 */
export const JIRA_QUICK_FILTERS: readonly { id: string; label: string; jql: string }[] = [
  {
    id: 'my-open',
    label: 'My open tickets',
    jql: 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC'
  },
  {
    id: 'my-sprint',
    label: 'My current sprint',
    jql: 'assignee = currentUser() AND sprint in openSprints() ORDER BY rank ASC'
  },
  {
    id: 'reported-by-me',
    label: 'Reported by me',
    jql: 'reporter = currentUser() AND resolution = Unresolved ORDER BY created DESC'
  },
  {
    id: 'recently-updated',
    label: 'Recently updated',
    jql: 'updated >= -7d ORDER BY updated DESC'
  }
] as const

/** Fallback JQL the panel loads with. */
export const JIRA_DEFAULT_JQL = JIRA_QUICK_FILTERS[0].jql

/**
 * Longest JQL string the search handler accepts. Real queries are well under
 * this; the cap exists so a runaway renderer cannot post an unbounded string.
 */
export const JIRA_MAX_JQL_CHARS = 2000
