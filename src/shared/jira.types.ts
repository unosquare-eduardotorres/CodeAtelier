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
  /** Priority name as configured on this instance, e.g. "Highest" / "Blocker". */
  priority?: string
  /** Epic or parent issue key, when the issue has one. */
  parentKey?: string
  /**
   * Summary of that parent, when Jira returned it.
   *
   * Jira nests it inside the `parent` field it already sends, so this costs no
   * extra round trip. Absent on Jira Server / DC classic projects, where the
   * epic link is a per-instance custom field rather than `parent`.
   */
  parentSummary?: string
  /**
   * Issue type of that parent, e.g. "Epic" or "Story".
   *
   * On Cloud `parent` is the epic for a story *and* the story for a sub-task,
   * so the type is the only thing that says which of the two you are looking
   * at. Carried so a grouped brief can name it correctly instead of calling
   * every shared parent an epic.
   */
  parentType?: string
  /** ISO timestamp from Jira */
  updated?: string
  /** ISO timestamp from Jira */
  created?: string
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
  /** Summary of the parent/epic, when Jira returned it. See `JiraIssueRow`. */
  parentSummary?: string
  /** Issue type of the parent, e.g. "Epic" or "Story". See `JiraIssueRow`. */
  parentType?: string
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
  /**
   * Opaque handle for the next page — `nextPageToken` on Cloud, the next
   * `startAt` offset rendered as a string on Server / DC. Absent when the last
   * page has been reached. Callers pass it back verbatim; nothing but the
   * request builder may interpret it.
   */
  nextCursor?: string
}

/** A Jira project, as returned by the project list endpoint. */
export interface JiraProject {
  id: string
  key: string
  name: string
}

/** An Agile board. Only available where Jira Software is licensed. */
export interface JiraBoard {
  id: number
  name: string
  type?: string
}

/** A sprint on a board. */
export interface JiraSprint {
  id: number
  name: string
  state?: string
}

/** One workflow transition available on an issue right now. */
export interface JiraTransition {
  id: string
  name: string
  /** Status the issue lands in if this transition is executed. */
  toStatus?: string
  /**
   * Jira's own classification of that landing status — `new`, `indeterminate`
   * or `done`.
   *
   * The only signal that survives a non-English workflow, where matching on
   * "In Progress" or "Done" finds nothing. Absent on responses that did not
   * expand the status category (older Server / DC).
   */
  toCategory?: 'new' | 'indeterminate' | 'done'
}

/** What a pipeline-driven status write was trying to say about the work. */
export type JiraSyncIntent = 'in-progress' | 'done'

/**
 * What one automatic write-back actually did, per ticket.
 *
 * Recorded on the blueprint rather than only logged: a write to a board the
 * whole team reads should be visible where the run is, and a *failed* write is
 * worse than none — without this the board looks current when it is not.
 */
export interface JiraSyncOutcome {
  intent: JiraSyncIntent
  /** ISO timestamp of the attempt. */
  at: string
  /** Tickets that changed status. */
  moved: string[]
  /** Tickets whose workflow offered no matching transition — not a failure. */
  skipped: string[]
  failed: { key: string; error: string }[]
  /**
   * Tickets that got a comment instead of a transition, because the run
   * finished with unverified checks. Only ever set for `done`.
   */
  commented?: string[]
}

/** At most one outcome per intent, newest write wins. */
export type JiraSyncLog = Partial<Record<JiraSyncIntent, JiraSyncOutcome>>

/**
 * Read the sync ledger off a blueprint's `settingsJson`.
 *
 * Shape-checked rather than cast: `settings_json` is a free-form column written
 * by several code paths, and a malformed entry must render as "no sync" instead
 * of throwing inside a detail pane.
 */
export function readJiraSyncLog(settings: Record<string, unknown> | null | undefined): JiraSyncLog {
  const raw = settings?.jiraSync
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const log: JiraSyncLog = {}
  for (const intent of ['in-progress', 'done'] as const) {
    const entry = (raw as Record<string, unknown>)[intent]
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Partial<JiraSyncOutcome>
    if (!Array.isArray(e.moved) || !Array.isArray(e.skipped) || !Array.isArray(e.failed)) continue
    log[intent] = {
      intent,
      at: typeof e.at === 'string' ? e.at : '',
      moved: e.moved.filter((k): k is string => typeof k === 'string'),
      skipped: e.skipped.filter((k): k is string => typeof k === 'string'),
      failed: e.failed.filter(
        (f): f is { key: string; error: string } =>
          !!f && typeof f === 'object' && typeof f.key === 'string'
      ),
      ...(Array.isArray(e.commented)
        ? { commented: e.commented.filter((k): k is string => typeof k === 'string') }
        : {})
    }
  }
  return log
}

/** The account the stored credentials belong to. */
export interface JiraCurrentUser {
  displayName: string
  /** `accountId` on Cloud, `name` on Server / DC — whichever the assign API wants. */
  accountId?: string
  name?: string
}

/**
 * The one blueprint a convert run produced.
 *
 * A selection converts to a *single* blueprint rather than one per ticket: ten
 * tickets under an epic are one piece of work, and ten blueprints would mean ten
 * branches and ten Specify runs for it.
 */
export interface JiraBlueprintConversion {
  blueprintId: string
  title: string
  /** Every ticket folded into this blueprint, in selection order. */
  issueKeys: string[]
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
  /** Null when every selected ticket was skipped or failed. */
  created: JiraBlueprintConversion | null
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

/**
 * Ceiling on how many rows "Load more" will accumulate in the renderer.
 *
 * Ten pages. A deliberately broad JQL against a large instance would otherwise
 * pull thousands of rows into React state and make the list the slowest thing
 * in the app; past this point the answer is a narrower query, not more paging.
 */
export const JIRA_MAX_LOADED_ROWS = 500

/**
 * Largest selection the convert-to-blueprint action accepts — i.e. how many
 * tickets may be folded into one blueprint.
 *
 * Mirrored from the IPC handler's own guard so the toolbar can cap the
 * selection with a visible reason instead of letting the call be rejected.
 */
export const JIRA_MAX_BULK_ISSUES = 25
