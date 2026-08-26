/**
 * Jira REST access for the Jira tickets panel.
 *
 * The MCP server (`mcp-servers/jira-server.ts`) exists so the *agent* can reach
 * Jira mid-conversation. This service exists so the *UI* can, without spawning
 * a child process or requiring the integration to be toggled on for chat — the
 * panel is useful before anyone enables the pill.
 *
 * Both sides share the pure helpers in `mcp-servers/jira-api.ts`, so auth
 * headers, API-version selection and response shaping cannot drift apart.
 *
 * Uses Electron's `net.fetch` rather than global fetch for the same reason
 * `jira-connection-test` does: it goes through Chromium's network stack, which
 * inherits the system proxy configuration and the OS certificate store. That is
 * what makes on-prem Jira behind a corporate VPN with an internal CA work.
 */

import { net } from 'electron'
import log from 'electron-log/main'
import type {
  JiraBoard,
  JiraCurrentUser,
  JiraIssueDetail,
  JiraIssueRow,
  JiraProject,
  JiraSearchResult,
  JiraSprint,
  JiraTransition
} from '../../shared/jira.types'
import {
  ISSUE_FIELDS,
  ISSUE_KEY_RE,
  apiUrl,
  buildAssigneeBody,
  buildBoardsRequest,
  buildCommentBody,
  buildHeaders,
  buildProjectsRequest,
  buildSearchRequest,
  buildSprintsRequest,
  buildTransitionBody,
  extractJiraErrorText,
  formatBoards,
  formatCurrentUser,
  formatIssue,
  formatProjects,
  formatSearchRows,
  formatSprints,
  formatTransitions,
  issueBrowseUrl,
  mapHttpStatus,
  mapNetworkError,
  type JiraConfig
} from '../mcp-servers/jira-api'
import { effectiveCredentialValues, findIntegration } from './integration-credentials'
import { jiraConfigFromFieldValues } from './jira-connection-test'

const jiraLog = log.scope('jira-rest')

const REQUEST_TIMEOUT_MS = 20_000

/** Hard cap on a single page. Jira Cloud's own `/search/jql` caps at 100. */
const MAX_RESULTS_CAP = 50

/** Comment / description budget for the panel — see `getIssue`. */
const UI_MAX_COMMENTS = 50
const UI_MAX_DESCRIPTION_CHARS = 50_000

/**
 * Errors whose `message` is already safe to show the user.
 * Anything else is logged and replaced with a generic string, so a stack trace
 * or a URL carrying credentials never reaches the renderer.
 */
export class JiraRequestError extends Error {
  /**
   * HTTP status, when the failure was one. Carried so callers can degrade on a
   * specific code — the Agile API simply does not exist on Jira Core, and a 404
   * there means "no boards", not "something broke".
   */
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/**
 * Resolve the workspace's stored Jira credentials into a config.
 * Returns null when the integration is not configured — callers surface that as
 * "connect Jira first" rather than as a failure.
 */
export function resolveJiraConfig(workspaceId: string): JiraConfig | null {
  const integration = findIntegration('jira')
  if (!integration) return null

  const values = effectiveCredentialValues(integration, workspaceId)
  const config = jiraConfigFromFieldValues(values)
  if (!config.baseUrl || !config.apiToken) return null
  return config
}

/** Narrow the config or throw a message the panel can render verbatim. */
function requireConfig(workspaceId: string): JiraConfig {
  const config = resolveJiraConfig(workspaceId)
  if (!config) {
    throw new JiraRequestError(
      'Jira is not connected for this workspace. Add your site URL and API token in the Jira tab.'
    )
  }
  return config
}

/**
 * Issue a Jira REST request and return parsed JSON.
 * Throws `JiraRequestError` with a user-facing message; never includes the token.
 */
async function jiraRequest(
  config: JiraConfig,
  url: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: string }
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await net.fetch(url, {
      method: init.method,
      headers: buildHeaders(config),
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal
    })

    if (!response.ok) {
      const mapped = mapHttpStatus(response.status, config.baseUrl)
      // Jira explains a rejected JQL clause in the body; "Jira returned HTTP
      // 400." on its own tells the user nothing they can fix. 401/403 keep the
      // mapped token guidance, which is more actionable than Jira's generic
      // "Client must be authenticated".
      const detail =
        response.status === 401 || response.status === 403 ? null : await readErrorDetail(response)
      throw new JiraRequestError(
        detail ? `${mapped.message} ${detail}` : mapped.message,
        response.status
      )
    }

    // 204 No Content is a valid success for some write endpoints, and calling
    // .json() on an empty body throws — treat it as "succeeded, nothing to read".
    if (response.status === 204) return null

    try {
      return await response.json()
    } catch (err) {
      // The abort timer kills the body read too, so a timeout mid-parse lands
      // here. Reporting that as an SSO/proxy problem points at the wrong thing.
      if (controller.signal.aborted) throw new JiraRequestError(mapNetworkError(err).message)
      throw new JiraRequestError(
        'Jira returned a response that was not JSON. This usually means a proxy or SSO login page answered instead of Jira — check the site URL and your VPN.'
      )
    }
  } catch (err) {
    if (err instanceof JiraRequestError) throw err
    throw new JiraRequestError(mapNetworkError(err).message)
  } finally {
    clearTimeout(timer)
  }
}

/** Jira's own error text for a failed response, or null if the body has none. */
async function readErrorDetail(response: { json(): Promise<unknown> }): Promise<string | null> {
  try {
    return extractJiraErrorText(await response.json())
  } catch {
    // A proxy or SSO page answering with HTML lands here — nothing to add.
    return null
  }
}

/**
 * Issue an Agile (Jira Software) request, or return null when the API is absent.
 *
 * Jira Core has no Agile API and answers 404; some Data Center deployments
 * answer 403 for accounts without the Software licence. Neither is a fault the
 * user can act on, and surfacing it as an error would break a panel whose board
 * picker is optional — so the caller hides the control instead.
 */
async function agileRequest(config: JiraConfig, url: string): Promise<unknown | null> {
  try {
    return await jiraRequest(config, url, { method: 'GET' })
  } catch (err) {
    if (err instanceof JiraRequestError && (err.status === 404 || err.status === 403)) {
      jiraLog.info(`Agile API unavailable (HTTP ${err.status}) — board controls stay hidden`)
      return null
    }
    throw err
  }
}

/**
 * Run a JQL query and return compact rows for the ticket list.
 *
 * `cursor` comes from a previous result's `nextCursor` and is passed straight
 * back to the request builder — Cloud's is an opaque token, DC's is an offset,
 * and nothing outside `buildSearchRequest` needs to know which.
 */
export async function searchIssues(
  workspaceId: string,
  jql: string,
  maxResults = 25,
  cursor?: string
): Promise<JiraSearchResult> {
  const config = requireConfig(workspaceId)
  const capped = Math.min(Math.max(Math.trunc(maxResults) || 1, 1), MAX_RESULTS_CAP)

  const request = buildSearchRequest(config.baseUrl, jql, capped, cursor)
  const raw = await jiraRequest(config, request.url, {
    method: request.method,
    ...(request.body ? { body: request.body } : {})
  })

  const shaped = formatSearchRows(raw as never)
  jiraLog.info(`search returned ${shaped.count} issue(s)${cursor ? ' (continuation)' : ''}`)

  return {
    issues: shaped.issues as unknown as JiraIssueRow[],
    count: shaped.count,
    ...(shaped.total === undefined ? {} : { total: shaped.total }),
    ...(shaped.hasMore === undefined ? {} : { hasMore: shaped.hasMore }),
    ...(shaped.nextCursor === undefined ? {} : { nextCursor: shaped.nextCursor })
  }
}

/** Projects visible to the account — one page, ordered by recent activity. */
export async function listProjects(workspaceId: string): Promise<JiraProject[]> {
  const config = requireConfig(workspaceId)
  const request = buildProjectsRequest(config.baseUrl)
  const raw = await jiraRequest(config, request.url, { method: request.method })
  return formatProjects(raw)
}

/** Boards for one project, or [] where the Agile API is not available. */
export async function listBoards(workspaceId: string, projectKey: string): Promise<JiraBoard[]> {
  const config = requireConfig(workspaceId)
  const request = buildBoardsRequest(config.baseUrl, projectKey)
  const raw = await agileRequest(config, request.url)
  return raw === null ? [] : formatBoards(raw)
}

/** Active and future sprints on a board, or [] where Agile is not available. */
export async function listSprints(workspaceId: string, boardId: number): Promise<JiraSprint[]> {
  const config = requireConfig(workspaceId)
  const request = buildSprintsRequest(config.baseUrl, boardId)
  const raw = await agileRequest(config, request.url)
  return raw === null ? [] : formatSprints(raw)
}

/** The account the stored credentials belong to — who "assign to me" means. */
export async function getCurrentUser(workspaceId: string): Promise<JiraCurrentUser> {
  const config = requireConfig(workspaceId)
  const raw = await jiraRequest(config, apiUrl(config.baseUrl, 'myself'), { method: 'GET' })
  return formatCurrentUser(raw)
}

/** Validate an issue key or throw a message the panel can render verbatim. */
function requireIssueKey(issueKey: string): string {
  const key = issueKey.trim().toUpperCase()
  if (!ISSUE_KEY_RE.test(key)) {
    throw new JiraRequestError(`Invalid issue key "${issueKey}". Expected a format like PROJ-123.`)
  }
  return key
}

/**
 * Assign an issue to the account behind the stored credentials.
 *
 * The identity is re-read rather than cached: a workspace whose token was
 * swapped for a service account would otherwise keep assigning to whoever set
 * it up first.
 */
export async function assignToMe(workspaceId: string, issueKey: string): Promise<JiraCurrentUser> {
  const key = requireIssueKey(issueKey)
  const config = requireConfig(workspaceId)
  const user = await getCurrentUser(workspaceId)

  await jiraRequest(config, apiUrl(config.baseUrl, `issue/${key}/assignee`), {
    method: 'PUT',
    body: buildAssigneeBody(config.baseUrl, user)
  })
  jiraLog.info(`Assigned ${key} to ${user.displayName}`)
  return user
}

/**
 * Transitions this workflow allows on the issue right now.
 *
 * Ids are per-workflow, so this is the only way to know what "In Progress"
 * means for a given project.
 */
export async function listTransitions(
  workspaceId: string,
  issueKey: string
): Promise<JiraTransition[]> {
  const key = requireIssueKey(issueKey)
  const config = requireConfig(workspaceId)
  const raw = await jiraRequest(config, apiUrl(config.baseUrl, `issue/${key}/transitions`), {
    method: 'GET'
  })
  return formatTransitions(raw)
}

/** Execute one workflow transition. */
export async function transitionIssue(
  workspaceId: string,
  issueKey: string,
  transitionId: string
): Promise<void> {
  const key = requireIssueKey(issueKey)
  const id = transitionId.trim()
  if (id.length === 0) throw new JiraRequestError('No transition selected.')

  const config = requireConfig(workspaceId)
  await jiraRequest(config, apiUrl(config.baseUrl, `issue/${key}/transitions`), {
    method: 'POST',
    body: buildTransitionBody(id)
  })
  jiraLog.info(`Transitioned ${key} via transition ${id}`)
}

/** Fetch one issue with description and recent comments. */
export async function getIssue(workspaceId: string, issueKey: string): Promise<JiraIssueDetail> {
  const key = requireIssueKey(issueKey)
  const config = requireConfig(workspaceId)
  const raw = await jiraRequest(
    config,
    `${apiUrl(config.baseUrl, `issue/${key}`)}?fields=${ISSUE_FIELDS}`,
    {
      method: 'GET'
    }
  )

  return {
    // `formatIssue` defaults are sized for the MCP server, where every character
    // is context the model pays for. The panel renders into a scroll pane and a
    // human reads it, so the only reason to truncate here is sanity.
    ...(formatIssue(raw as never, {
      maxComments: UI_MAX_COMMENTS,
      maxDescriptionChars: UI_MAX_DESCRIPTION_CHARS
    }) as unknown as Omit<JiraIssueDetail, 'browseUrl'>),
    browseUrl: issueBrowseUrl(config.baseUrl, key)
  }
}

/**
 * Download one attachment's bytes.
 *
 * Separate from `jiraRequest` because that helper parses JSON and this returns
 * binary. The URL comes from Jira's own attachment record rather than being
 * constructed, and is checked against the configured site so a hostile issue
 * payload cannot redirect the credentialed request somewhere else.
 */
export async function downloadAttachment(
  workspaceId: string,
  contentUrl: string,
  maxBytes: number
): Promise<Buffer> {
  const config = requireConfig(workspaceId)

  let target: URL
  let site: URL
  try {
    target = new URL(contentUrl)
    site = new URL(config.baseUrl)
  } catch {
    throw new JiraRequestError('Attachment URL is malformed.')
  }
  if (target.origin !== site.origin) {
    throw new JiraRequestError(
      `Attachment is hosted on ${target.host}, not the configured Jira site. Refusing to send credentials there.`
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(target.toString(), {
      method: 'GET',
      headers: buildHeaders(config),
      signal: controller.signal
    })
    if (!response.ok) {
      throw new JiraRequestError(mapHttpStatus(response.status, config.baseUrl).message)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    // Jira's reported size is advisory; this is the check that actually bounds
    // what lands on disk.
    if (bytes.byteLength > maxBytes) {
      throw new JiraRequestError(
        `Attachment is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit.`
      )
    }
    return bytes
  } catch (err) {
    if (err instanceof JiraRequestError) throw err
    throw new JiraRequestError(mapNetworkError(err).message)
  } finally {
    clearTimeout(timer)
  }
}

/** Post a comment on an issue. The only write this service performs. */
export async function addComment(
  workspaceId: string,
  issueKey: string,
  body: string
): Promise<void> {
  const key = requireIssueKey(issueKey)
  const text = body.trim()
  if (text.length === 0) {
    throw new JiraRequestError('Comment is empty.')
  }

  const config = requireConfig(workspaceId)
  await jiraRequest(config, apiUrl(config.baseUrl, `issue/${key}/comment`), {
    method: 'POST',
    body: buildCommentBody(config.baseUrl, text)
  })
  jiraLog.info(`Posted comment on ${key}`)
}
