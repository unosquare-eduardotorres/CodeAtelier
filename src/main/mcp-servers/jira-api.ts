/**
 * Pure Jira REST helpers — shared by the bundled `jira-server` MCP process and
 * the main-process connection test.
 *
 * Dependency-free by design (no Electron, no fetch calls) so both sides agree
 * on auth headers, API version selection and response shaping, and so the logic
 * is unit-testable without a network.
 *
 * Cloud vs Data Center differences handled here:
 *   - API version: Cloud uses /rest/api/3, DC/Server has no v3 → /rest/api/2
 *   - Search: Cloud removed POST /search in 2025 → GET /search/jql
 *   - Description: Cloud returns ADF (a document tree), DC returns wiki markup
 *   - Comments: Cloud accepts only ADF on write, DC accepts a plain string
 */

export type JiraAuthMode = 'cloud-token' | 'pat' | 'basic'

export interface JiraConfig {
  baseUrl: string
  authMode: JiraAuthMode
  /** Atlassian account email — cloud-token mode */
  email?: string
  /** Username — basic mode */
  username?: string
  apiToken: string
}

/** Issue keys look like PROJ-123 / AB1_C-9. Anything else is rejected early. */
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/

/** Strip trailing slashes so `${baseUrl}/rest/...` never double-slashes. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/** Jira Cloud is *.atlassian.net; everything else is treated as Server / DC. */
export function isCloudHost(baseUrl: string): boolean {
  try {
    return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase().endsWith('.atlassian.net')
  } catch {
    return false
  }
}

/** REST API version: 3 on Cloud, 2 on Server / Data Center. */
export function apiVersion(baseUrl: string): '2' | '3' {
  return isCloudHost(baseUrl) ? '3' : '2'
}

/** Absolute URL for a REST path, e.g. apiUrl(cfg, 'myself'). */
export function apiUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/rest/api/${apiVersion(baseUrl)}/${path}`
}

/**
 * Absolute URL for an Agile (Jira Software) REST path.
 *
 * Deliberately bypasses `apiUrl`'s v2/v3 selection: the Agile API is unversioned
 * at `/rest/agile/1.0` and identical on Cloud and Data Center. It is also the
 * one API that may simply not exist — Jira Core has no Jira Software licence and
 * answers 404 — so every caller must treat a miss as "no boards here", never as
 * an error.
 */
export function agileUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/rest/agile/1.0/${path}`
}

/** Web UI deep link for an issue — what "Open in Jira" navigates to. */
export function issueBrowseUrl(baseUrl: string, issueKey: string): string {
  return `${normalizeBaseUrl(baseUrl)}/browse/${issueKey}`
}

/**
 * Authorization header value for the configured auth mode.
 * PAT (Data Center 8.14+) is a bearer token; the other two are HTTP Basic.
 */
export function buildAuthHeader(config: JiraConfig): string {
  switch (config.authMode) {
    case 'pat':
      return `Bearer ${config.apiToken}`
    case 'basic':
      return `Basic ${Buffer.from(`${config.username ?? ''}:${config.apiToken}`).toString('base64')}`
    case 'cloud-token':
    default:
      return `Basic ${Buffer.from(`${config.email ?? ''}:${config.apiToken}`).toString('base64')}`
  }
}

/** Standard request headers. Never includes anything but the auth token. */
export function buildHeaders(config: JiraConfig): Record<string, string> {
  return {
    Authorization: buildAuthHeader(config),
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
}

/** Read a Jira config out of the MCP child process environment. */
export function jiraConfigFromEnv(env: NodeJS.ProcessEnv = process.env): JiraConfig | null {
  const baseUrl = env.JIRA_BASE_URL
  const apiToken = env.JIRA_API_TOKEN
  if (!baseUrl || !apiToken) return null

  const mode = env.JIRA_AUTH_MODE
  const authMode: JiraAuthMode =
    mode === 'pat' || mode === 'basic' || mode === 'cloud-token' ? mode : 'cloud-token'

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    authMode,
    email: env.JIRA_EMAIL,
    username: env.JIRA_USERNAME,
    apiToken
  }
}

// ── Error mapping ──

export type JiraErrorCode =
  'ok' | 'auth-failed' | 'not-found' | 'network' | 'cert' | 'proxy' | 'timeout'

/** Map an HTTP status onto a machine code + user-facing message. */
export function mapHttpStatus(
  status: number,
  baseUrl: string
): { code: JiraErrorCode; message: string } {
  if (status >= 200 && status < 300) return { code: 'ok', message: 'OK' }
  if (status === 401 || status === 403) {
    return {
      code: 'auth-failed',
      message: isCloudHost(baseUrl)
        ? 'Authentication failed. Jira Cloud requires an API token (id.atlassian.com → Security → API tokens), not your account password.'
        : 'Authentication failed. Check your Personal Access Token — it may have expired or lack permission for this project.'
    }
  }
  if (status === 404) {
    return {
      code: 'not-found',
      message:
        'Not found (404). The Jira URL may be missing a context path, or the issue does not exist / is not visible to this account.'
    }
  }
  if (status === 429) {
    return { code: 'network', message: 'Rate limited by Jira (429). Try again shortly.' }
  }
  return { code: 'network', message: `Jira returned HTTP ${status}.` }
}

/**
 * Pull Jira's own explanation out of an error response body.
 *
 * A malformed JQL clause comes back as a 400 whose body says exactly which
 * clause was rejected — `mapHttpStatus` alone would collapse that to "Jira
 * returned HTTP 400.", which tells the user nothing they can act on. Returns
 * null when the body carries no message, so the caller keeps its own wording.
 *
 * Length-capped: `errors` can carry one entry per field on a large payload, and
 * this text goes straight into the UI.
 */
export function extractJiraErrorText(body: unknown, maxChars = 500): string | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { errorMessages?: unknown; errors?: unknown; message?: unknown }

  const parts: string[] = []
  if (Array.isArray(b.errorMessages)) {
    for (const entry of b.errorMessages) {
      if (typeof entry === 'string' && entry.trim().length > 0) parts.push(entry.trim())
    }
  }
  if (b.errors && typeof b.errors === 'object' && !Array.isArray(b.errors)) {
    for (const [field, value] of Object.entries(b.errors as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim().length > 0)
        parts.push(`${field}: ${value.trim()}`)
    }
  }
  if (parts.length === 0 && typeof b.message === 'string' && b.message.trim().length > 0) {
    parts.push(b.message.trim())
  }

  if (parts.length === 0) return null
  const text = parts.join(' ')
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text
}

/** Map a thrown network error onto a machine code + user-facing message. */
export function mapNetworkError(err: unknown): { code: JiraErrorCode; message: string } {
  const raw =
    err instanceof Error
      ? `${err.message} ${String((err as { code?: string }).code ?? '')}`
      : String(err)
  const text = raw.toUpperCase()

  if (text.includes('ABORT') || text.includes('TIMEOUT') || text.includes('ETIMEDOUT')) {
    return {
      code: 'timeout',
      message:
        'Timed out reaching Jira. If this is an on-prem host, check that the VPN is connected.'
    }
  }
  if (text.includes('CERT') || text.includes('SELF_SIGNED') || text.includes('UNABLE_TO_VERIFY')) {
    return {
      code: 'cert',
      message:
        'TLS certificate not trusted. On-prem Jira often uses an internal CA — install it in the OS trust store, or set NODE_EXTRA_CA_CERTS.'
    }
  }
  if (
    text.includes('PROXY') ||
    text.includes('ENOTFOUND') ||
    text.includes('ERR_NAME_NOT_RESOLVED')
  ) {
    return {
      code: 'proxy',
      message:
        'Could not resolve or reach the Jira host. Check the URL, and whether you are connected to the VPN / behind a proxy.'
    }
  }
  return {
    code: 'network',
    message: `Could not reach Jira: ${err instanceof Error ? err.message : String(err)}`
  }
}

// ── Response shaping ──

/**
 * Flatten Atlassian Document Format (Cloud v3) into plain text.
 * Data Center returns a plain wiki-markup string, which is passed through.
 */
export function flattenAdf(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)

  const node = value as { type?: string; text?: string; content?: unknown[] }

  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'text') return node.text ?? ''

  // Media nodes carry no text and no children, so the default branch used to
  // return '' and the image vanished without trace — leaving briefs that say
  // "see the red banner below" with nothing below. A placeholder keeps the
  // reference honest; the bytes arrive separately as reference documents.
  if (node.type === 'media' || node.type === 'mediaInline') {
    const attrs = (value as { attrs?: { alt?: string; id?: string } }).attrs
    return `[image: ${attrs?.alt || 'see attachments'}]`
  }

  const inner = Array.isArray(node.content) ? node.content.map(flattenAdf).join('') : ''

  switch (node.type) {
    case 'paragraph':
    case 'heading':
    case 'listItem':
    case 'blockquote':
      return `${inner}\n`
    case 'bulletList':
    case 'orderedList':
    case 'codeBlock':
      return `${inner}\n`
    default:
      return inner
  }
}

interface JiraIssueRaw {
  key?: string
  fields?: Record<string, unknown>
}

/**
 * Shape the `attachment` field into the subset we act on.
 *
 * `content` is an authenticated download URL, not a public one — pasting it
 * into a prompt yields a 401, so it is only ever consumed by a request that
 * carries the same credentials as the issue fetch.
 */
export function formatAttachments(raw: unknown): Array<{
  id: string
  filename: string
  mimeType?: string
  size?: number
  contentUrl: string
}> {
  if (!Array.isArray(raw)) return []
  const shaped: Array<{
    id: string
    filename: string
    mimeType?: string
    size?: number
    contentUrl: string
  }> = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const a = entry as {
      id?: unknown
      filename?: unknown
      mimeType?: unknown
      size?: unknown
      content?: unknown
    }
    if (typeof a.filename !== 'string' || typeof a.content !== 'string') continue
    shaped.push({
      id: String(a.id ?? ''),
      filename: a.filename,
      ...(typeof a.mimeType === 'string' ? { mimeType: a.mimeType } : {}),
      ...(typeof a.size === 'number' ? { size: a.size } : {}),
      contentUrl: a.content
    })
  }
  return shaped
}

function nameOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as { displayName?: string; name?: string; value?: string }
  return v.displayName ?? v.name ?? v.value
}

/** The epic / parent key Jira nests under the `parent` field. */
function parentKeyOf(parent: unknown): string | undefined {
  return (parent as { key?: string } | undefined)?.key
}

/**
 * The parent's summary, which Jira ships inside the same `parent` object.
 *
 * Free of charge wherever `parent` is populated, which is Jira Cloud and modern
 * team-managed projects. Server / DC classic projects carry the epic link in a
 * per-instance custom field instead, so this is simply absent there.
 */
function parentSummaryOf(parent: unknown): string | undefined {
  const p = parent as { summary?: unknown; fields?: { summary?: unknown } } | undefined
  // Cloud nests the parent's own fields under `fields`; both shapes are read
  // because this is one field on one object and guessing wrong loses the title.
  const summary = p?.fields?.summary ?? p?.summary
  return typeof summary === 'string' && summary.length > 0 ? summary : undefined
}

/**
 * The parent's issue type name — "Epic" for a story's parent, "Story" for a
 * sub-task's.
 *
 * Cloud reuses one `parent` field for both relationships, so without this a
 * group of sub-tasks would be presented to the agent as an epic.
 */
function parentTypeOf(parent: unknown): string | undefined {
  const p = parent as { issuetype?: unknown; fields?: { issuetype?: unknown } } | undefined
  return nameOf(p?.fields?.issuetype ?? p?.issuetype)
}

/** Compact, LLM-friendly shape for a single issue. */
export function formatIssue(
  raw: JiraIssueRaw,
  opts: { maxComments?: number; maxDescriptionChars?: number } = {}
): Record<string, unknown> {
  const f = raw.fields ?? {}
  const maxComments = opts.maxComments ?? 5
  const maxDescription = opts.maxDescriptionChars ?? 6000

  const description = flattenAdf(f.description).trim()

  const commentContainer = f.comment as { comments?: unknown[] } | undefined
  const comments = Array.isArray(commentContainer?.comments)
    ? commentContainer.comments.slice(-maxComments).map((c) => {
        const comment = c as { author?: unknown; created?: string; body?: unknown }
        return {
          author: nameOf(comment.author) ?? 'unknown',
          created: comment.created,
          body: flattenAdf(comment.body).trim().slice(0, 2000)
        }
      })
    : []

  return {
    key: raw.key,
    summary: f.summary,
    type: nameOf(f.issuetype),
    status: nameOf(f.status),
    priority: nameOf(f.priority),
    assignee: nameOf(f.assignee) ?? 'Unassigned',
    reporter: nameOf(f.reporter),
    labels: Array.isArray(f.labels) ? f.labels : [],
    parent: parentKeyOf(f.parent),
    parentSummary: parentSummaryOf(f.parent),
    parentType: parentTypeOf(f.parent),
    resolution: nameOf(f.resolution),
    created: f.created,
    updated: f.updated,
    description:
      description.length > maxDescription
        ? `${description.slice(0, maxDescription)}\n[...description truncated...]`
        : description,
    comments,
    attachments: formatAttachments(f.attachment)
  }
}

/**
 * Compact rows for a JQL result set.
 *
 * `total` is omitted on Jira Cloud: `GET /search/jql` does not return one (it
 * paginates with `nextPageToken` / `isLast`), and defaulting it to the page size
 * would tell the model "7 issues exist" when it has only seen the first page.
 * `hasMore` carries that signal instead.
 */
export function formatSearchRows(
  raw:
    | {
        issues?: unknown[]
        total?: number
        startAt?: number
        isLast?: boolean
        nextPageToken?: string
      }
    | null
    | undefined
): {
  total?: number
  count: number
  hasMore?: boolean
  nextCursor?: string
  issues: Record<string, unknown>[]
} {
  const issues = Array.isArray(raw?.issues) ? raw.issues : []

  // Server / DC paginates by offset and reports a total, so the next cursor is
  // arithmetic. Cloud hands back an opaque token and no total at all — the two
  // shapes are resolved here so nothing downstream has to know which it got.
  const startAt = typeof raw?.startAt === 'number' ? raw.startAt : undefined
  const total = typeof raw?.total === 'number' ? raw.total : undefined
  const nextOffset =
    startAt !== undefined && total !== undefined && startAt + issues.length < total
      ? startAt + issues.length
      : undefined

  const nextCursor =
    typeof raw?.nextPageToken === 'string' && raw.nextPageToken.length > 0
      ? raw.nextPageToken
      : nextOffset !== undefined
        ? String(nextOffset)
        : undefined

  const hasMore =
    typeof raw?.nextPageToken === 'string'
      ? true
      : typeof raw?.isLast === 'boolean'
        ? !raw.isLast
        : nextOffset !== undefined
          ? true
          : total !== undefined && startAt !== undefined
            ? false
            : undefined

  return {
    ...(total === undefined ? {} : { total }),
    count: issues.length,
    ...(hasMore === undefined ? {} : { hasMore }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    issues: issues.map((i) => {
      const issue = i as JiraIssueRaw
      const f = issue.fields ?? {}
      return {
        key: issue.key,
        summary: f.summary,
        status: nameOf(f.status),
        type: nameOf(f.issuetype),
        assignee: nameOf(f.assignee) ?? 'Unassigned',
        priority: nameOf(f.priority),
        parentKey: parentKeyOf(f.parent),
        parentSummary: parentSummaryOf(f.parent),
        parentType: parentTypeOf(f.parent),
        updated: f.updated,
        created: f.created
      }
    })
  }
}

/** Fields requested for get_issue — keeps payloads small and predictable. */
export const ISSUE_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'parent',
  'resolution',
  'created',
  'updated',
  'description',
  'comment',
  'attachment'
].join(',')

/**
 * Fields requested for search_issues.
 *
 * `priority` and `parent` are here so the list can order by urgency and show an
 * epic without a second round trip per row. Sprint is deliberately absent: on
 * most instances it is a per-instance custom field id (`customfield_100xx`), so
 * there is no portable name to ask for — it stays a filter, not a column.
 */
export const SEARCH_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'assignee',
  'priority',
  'parent',
  'updated',
  'created'
].join(',')

/**
 * Request body for `POST /issue/{key}/comment`.
 *
 * Cloud's v3 endpoint rejects a plain string with a 400 — it wants Atlassian
 * Document Format. Server / DC's v2 endpoint wants the plain string and cannot
 * parse ADF, so the shape has to follow the same host check the read path uses.
 *
 * Blank lines split paragraphs; ADF forbids an empty `content` array on a
 * paragraph node, so empty lines are dropped rather than emitted as empty
 * paragraphs. Text is never trusted as markup — it goes in as literal text
 * nodes, so a comment containing `{code}` or `@here` cannot inject formatting.
 */
export function buildCommentBody(baseUrl: string, text: string): string {
  if (!isCloudHost(baseUrl)) return JSON.stringify({ body: text })

  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: block }]
    }))

  return JSON.stringify({
    body: {
      type: 'doc',
      version: 1,
      // A doc with no content is invalid ADF. An all-whitespace comment is
      // rejected upstream, but the fallback keeps this helper total.
      content:
        paragraphs.length > 0
          ? paragraphs
          : [{ type: 'paragraph', content: [{ type: 'text', text: text.trim() || '—' }] }]
    }
  })
}

/**
 * Search endpoint URL. Jira Cloud removed `POST /rest/api/3/search` in 2025 and
 * replaced it with `GET /rest/api/3/search/jql`; Server / DC still uses `/search`.
 */
export function buildSearchRequest(
  baseUrl: string,
  jql: string,
  maxResults: number,
  cursor?: string
): { url: string; method: 'GET' | 'POST'; body?: string } {
  const capped = Math.min(Math.max(maxResults, 1), 50)

  if (isCloudHost(baseUrl)) {
    const params = new URLSearchParams({
      jql,
      maxResults: String(capped),
      fields: SEARCH_FIELDS
    })
    // Cloud's cursor is opaque and goes back verbatim. Server / DC's is the
    // offset `formatSearchRows` computed, which only means anything as a number.
    if (cursor) params.set('nextPageToken', cursor)
    return { url: `${apiUrl(baseUrl, 'search/jql')}?${params.toString()}`, method: 'GET' }
  }

  const startAt = cursor === undefined ? 0 : Number.parseInt(cursor, 10)
  return {
    url: apiUrl(baseUrl, 'search'),
    method: 'POST',
    body: JSON.stringify({
      jql,
      maxResults: capped,
      fields: SEARCH_FIELDS.split(','),
      startAt: Number.isFinite(startAt) && startAt > 0 ? startAt : 0
    })
  }
}

// ── Projects, boards and sprints ──

/**
 * Project list request.
 *
 * Cloud has a paginated `project/search` that can be ordered by activity, which
 * is what makes the dropdown useful on a site with hundreds of projects. Server
 * / DC only has the unpaginated `project`, which returns a plain array.
 */
export function buildProjectsRequest(
  baseUrl: string,
  opts: { startAt?: number; maxResults?: number } = {}
): { url: string; method: 'GET' } {
  if (!isCloudHost(baseUrl)) {
    return { url: apiUrl(baseUrl, 'project'), method: 'GET' }
  }
  const params = new URLSearchParams({
    maxResults: String(Math.min(Math.max(opts.maxResults ?? 50, 1), 50)),
    startAt: String(Math.max(opts.startAt ?? 0, 0)),
    orderBy: 'lastIssueUpdatedTime'
  })
  return { url: `${apiUrl(baseUrl, 'project/search')}?${params.toString()}`, method: 'GET' }
}

/** Shape either project response — Cloud's `{ values: [] }` or DC's bare array. */
export function formatProjects(raw: unknown): Array<{ id: string; key: string; name: string }> {
  const entries = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { values?: unknown[] } | null)?.values)
      ? (raw as { values: unknown[] }).values
      : []

  const projects: Array<{ id: string; key: string; name: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const p = entry as { id?: unknown; key?: unknown; name?: unknown }
    if (typeof p.key !== 'string' || p.key.length === 0) continue
    projects.push({
      id: String(p.id ?? p.key),
      key: p.key,
      name: typeof p.name === 'string' && p.name.length > 0 ? p.name : p.key
    })
  }
  return projects
}

/** Boards for one project. Scoped because a site-wide board list is unusable. */
export function buildBoardsRequest(
  baseUrl: string,
  projectKeyOrId: string
): { url: string; method: 'GET' } {
  const params = new URLSearchParams({ projectKeyOrId, maxResults: '50' })
  return { url: `${agileUrl(baseUrl, 'board')}?${params.toString()}`, method: 'GET' }
}

/** Active and future sprints on a board. Closed sprints are not work to pick up. */
export function buildSprintsRequest(
  baseUrl: string,
  boardId: number | string
): { url: string; method: 'GET' } {
  const id = String(boardId).replace(/[^0-9]/g, '')
  const params = new URLSearchParams({ state: 'active,future', maxResults: '50' })
  return { url: `${agileUrl(baseUrl, `board/${id}/sprint`)}?${params.toString()}`, method: 'GET' }
}

/** Shape the Agile `values` array into boards. */
export function formatBoards(raw: unknown): Array<{ id: number; name: string; type?: string }> {
  const entries = Array.isArray((raw as { values?: unknown[] } | null)?.values)
    ? (raw as { values: unknown[] }).values
    : []
  const boards: Array<{ id: number; name: string; type?: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const b = entry as { id?: unknown; name?: unknown; type?: unknown }
    if (typeof b.id !== 'number') continue
    boards.push({
      id: b.id,
      name: typeof b.name === 'string' ? b.name : `Board ${b.id}`,
      ...(typeof b.type === 'string' ? { type: b.type } : {})
    })
  }
  return boards
}

/** Shape the Agile `values` array into sprints. */
export function formatSprints(raw: unknown): Array<{ id: number; name: string; state?: string }> {
  const entries = Array.isArray((raw as { values?: unknown[] } | null)?.values)
    ? (raw as { values: unknown[] }).values
    : []
  const sprints: Array<{ id: number; name: string; state?: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const s = entry as { id?: unknown; name?: unknown; state?: unknown }
    if (typeof s.id !== 'number') continue
    sprints.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : `Sprint ${s.id}`,
      ...(typeof s.state === 'string' ? { state: s.state } : {})
    })
  }
  return sprints
}

// ── Writes: assignee and workflow transitions ──

/**
 * Body for `PUT /issue/{key}/assignee`.
 *
 * Cloud identifies users by `accountId` (GDPR removed usernames from the API);
 * Server / DC still wants `name`. Sending the wrong one is a 400, so the shape
 * follows the same host check every other write does.
 */
export function buildAssigneeBody(
  baseUrl: string,
  user: { accountId?: string; name?: string }
): string {
  if (isCloudHost(baseUrl)) return JSON.stringify({ accountId: user.accountId ?? null })
  return JSON.stringify({ name: user.name ?? user.accountId ?? null })
}

/**
 * Shape `GET /issue/{key}/transitions`.
 *
 * Transition ids are per-workflow — "In Progress" is 21 on one project and 4 on
 * the next — so they can never be hardcoded and must be read per issue.
 */
export function formatTransitions(
  raw: unknown
): Array<{ id: string; name: string; toStatus?: string }> {
  const entries = Array.isArray((raw as { transitions?: unknown[] } | null)?.transitions)
    ? (raw as { transitions: unknown[] }).transitions
    : []
  const transitions: Array<{ id: string; name: string; toStatus?: string }> = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const t = entry as { id?: unknown; name?: unknown; to?: unknown }
    if (t.id === undefined || t.id === null) continue
    const toStatus = nameOf(t.to)
    transitions.push({
      id: String(t.id),
      name: typeof t.name === 'string' ? t.name : String(t.id),
      ...(toStatus ? { toStatus } : {})
    })
  }
  return transitions
}

/** Body for `POST /issue/{key}/transitions`. */
export function buildTransitionBody(transitionId: string): string {
  return JSON.stringify({ transition: { id: String(transitionId) } })
}

/** Shape `GET /myself` into the identity the assign API needs. */
export function formatCurrentUser(raw: unknown): {
  displayName: string
  accountId?: string
  name?: string
} {
  const u = (raw ?? {}) as {
    displayName?: unknown
    name?: unknown
    accountId?: unknown
    key?: unknown
  }
  const accountId =
    typeof u.accountId === 'string' ? u.accountId : typeof u.key === 'string' ? u.key : undefined
  return {
    displayName:
      typeof u.displayName === 'string' && u.displayName.length > 0
        ? u.displayName
        : typeof u.name === 'string'
          ? u.name
          : 'your account',
    ...(accountId ? { accountId } : {}),
    ...(typeof u.name === 'string' ? { name: u.name } : {})
  }
}
