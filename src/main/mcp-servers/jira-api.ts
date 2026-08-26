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
    parent: (f.parent as { key?: string } | undefined)?.key,
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
    | { issues?: unknown[]; total?: number; isLast?: boolean; nextPageToken?: string }
    | null
    | undefined
): {
  total?: number
  count: number
  hasMore?: boolean
  issues: Record<string, unknown>[]
} {
  const issues = Array.isArray(raw?.issues) ? raw.issues : []
  const hasMore =
    typeof raw?.nextPageToken === 'string'
      ? true
      : typeof raw?.isLast === 'boolean'
        ? !raw.isLast
        : undefined
  return {
    ...(typeof raw?.total === 'number' ? { total: raw.total } : {}),
    count: issues.length,
    ...(hasMore === undefined ? {} : { hasMore }),
    issues: issues.map((i) => {
      const issue = i as JiraIssueRaw
      const f = issue.fields ?? {}
      return {
        key: issue.key,
        summary: f.summary,
        status: nameOf(f.status),
        type: nameOf(f.issuetype),
        assignee: nameOf(f.assignee) ?? 'Unassigned',
        updated: f.updated
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

/** Fields requested for search_issues. */
export const SEARCH_FIELDS = ['summary', 'status', 'issuetype', 'assignee', 'updated'].join(',')

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
  maxResults: number
): { url: string; method: 'GET' | 'POST'; body?: string } {
  const capped = Math.min(Math.max(maxResults, 1), 50)
  if (isCloudHost(baseUrl)) {
    const params = new URLSearchParams({
      jql,
      maxResults: String(capped),
      fields: SEARCH_FIELDS
    })
    return { url: `${apiUrl(baseUrl, 'search/jql')}?${params.toString()}`, method: 'GET' }
  }
  return {
    url: apiUrl(baseUrl, 'search'),
    method: 'POST',
    body: JSON.stringify({ jql, maxResults: capped, fields: SEARCH_FIELDS.split(',') })
  }
}
