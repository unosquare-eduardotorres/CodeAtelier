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
import type { JiraIssueDetail, JiraIssueRow, JiraSearchResult } from '../../shared/jira.types'
import {
  ISSUE_FIELDS,
  ISSUE_KEY_RE,
  apiUrl,
  buildCommentBody,
  buildHeaders,
  buildSearchRequest,
  formatIssue,
  formatSearchRows,
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
export class JiraRequestError extends Error {}

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
  init: { method: 'GET' | 'POST'; body?: string }
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
      throw new JiraRequestError(mapHttpStatus(response.status, config.baseUrl).message)
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

/** Run a JQL query and return compact rows for the ticket list. */
export async function searchIssues(
  workspaceId: string,
  jql: string,
  maxResults = 25
): Promise<JiraSearchResult> {
  const config = requireConfig(workspaceId)
  const capped = Math.min(Math.max(Math.trunc(maxResults) || 1, 1), MAX_RESULTS_CAP)

  const request = buildSearchRequest(config.baseUrl, jql, capped)
  const raw = await jiraRequest(config, request.url, {
    method: request.method,
    ...(request.body ? { body: request.body } : {})
  })

  const shaped = formatSearchRows(raw as never)
  jiraLog.info(`search returned ${shaped.count} issue(s)`)

  return {
    issues: shaped.issues as unknown as JiraIssueRow[],
    count: shaped.count,
    ...(shaped.total === undefined ? {} : { total: shaped.total }),
    ...(shaped.hasMore === undefined ? {} : { hasMore: shaped.hasMore })
  }
}

/** Fetch one issue with description and recent comments. */
export async function getIssue(workspaceId: string, issueKey: string): Promise<JiraIssueDetail> {
  const key = issueKey.trim().toUpperCase()
  if (!ISSUE_KEY_RE.test(key)) {
    throw new JiraRequestError(`Invalid issue key "${issueKey}". Expected a format like PROJ-123.`)
  }

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
  const key = issueKey.trim().toUpperCase()
  if (!ISSUE_KEY_RE.test(key)) {
    throw new JiraRequestError(`Invalid issue key "${issueKey}". Expected a format like PROJ-123.`)
  }
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
