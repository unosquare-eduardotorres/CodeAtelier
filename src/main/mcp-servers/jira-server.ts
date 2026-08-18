#!/usr/bin/env node
/**
 * Jira MCP Server — bundled, first-party.
 *
 * Bundled rather than shelled out to a published server because the target
 * environment is Windows on a corporate VPN: `npx <pkg>` needs npmjs.org at
 * spawn time, and `npx.cmd` does not spawn without a shell on Windows.
 *
 * Exposes: get_issue, search_issues (read) and add_comment (write). Commenting
 * is the only mutation — status, assignee and fields are never touched, and the
 * registry withholds add_comment in plan mode.
 *
 * Environment variables (injected by resolveIntegrationEnv):
 *   JIRA_BASE_URL   — https://client.atlassian.net or https://jira.client.internal
 *   JIRA_AUTH_MODE  — cloud-token | pat | basic
 *   JIRA_EMAIL      — cloud-token mode
 *   JIRA_USERNAME   — basic mode
 *   JIRA_API_TOKEN  — API token / PAT / password
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { truncateToolOutput } from './output-cap'
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
  jiraConfigFromEnv,
  mapHttpStatus,
  mapNetworkError
} from './jira-api'

const REQUEST_TIMEOUT_MS = 20_000

const config = jiraConfigFromEnv()

const server = new McpServer({ name: 'jira', version: '1.0.0' }, { capabilities: { tools: {} } })

/** Tool-result helper — MCP has no error channel, so failures come back as text. */
function textResult(text: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text }] }
}

/** Marker for errors already carrying a user-facing message. */
class JiraUserError extends Error {}

/** Narrow the module-level config, failing with actionable guidance. */
function requireConfig(): NonNullable<typeof config> {
  if (!config) {
    throw new JiraUserError(
      'Jira is not configured. Open Settings → Integrations → Jira and add your site URL and API token.'
    )
  }
  return config
}

/**
 * Issue a Jira REST request. Returns parsed JSON, or throws an Error whose
 * message is already user-facing (never contains the token).
 */
async function jiraRequest(
  url: string,
  init: { method: 'GET' | 'POST'; body?: string }
): Promise<unknown> {
  const cfg = requireConfig()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: buildHeaders(cfg),
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new JiraUserError(mapHttpStatus(response.status, cfg.baseUrl).message)
    }

    // 204 No Content is a valid success for write endpoints, and calling
    // .json() on an empty body throws.
    if (response.status === 204) return null

    // Parsed separately: a body that is not JSON is a Jira/proxy problem, and
    // mapNetworkError would mislabel it as "Could not reach Jira".
    try {
      return await response.json()
    } catch (err) {
      // The timer aborts the body read too, so a timeout during `.json()` arrives
      // here as an AbortError — reporting that as a proxy/SSO problem points the
      // user at the wrong subsystem on a slow VPN.
      if (controller.signal.aborted) throw new JiraUserError(mapNetworkError(err).message)
      throw new JiraUserError(
        'Jira returned a response that was not JSON. This usually means a proxy or SSO login page answered instead of Jira — check the site URL and your VPN.'
      )
    }
  } catch (err) {
    if (err instanceof JiraUserError) throw err
    throw new JiraUserError(mapNetworkError(err).message)
  } finally {
    clearTimeout(timer)
  }
}

server.tool(
  'get_issue',
  'Read one Jira ticket by key — summary, status, assignee, priority, labels, description and recent comments. Use this when the user references an issue key (e.g. PROJ-123) so you work from the real acceptance criteria instead of guessing.',
  {
    issueKey: z.string().describe('Jira issue key, e.g. PROJ-123')
  },
  async (args) => {
    const issueKey = args.issueKey.trim().toUpperCase()
    if (!ISSUE_KEY_RE.test(issueKey)) {
      return textResult(`Invalid issue key "${args.issueKey}". Expected a format like PROJ-123.`)
    }
    try {
      const url = `${apiUrl(requireConfig().baseUrl, `issue/${issueKey}`)}?fields=${ISSUE_FIELDS}`
      const raw = await jiraRequest(url, { method: 'GET' })
      return textResult(
        truncateToolOutput(JSON.stringify(formatIssue(raw as never), null, 2), 20_000)
      )
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err))
    }
  }
)

server.tool(
  'search_issues',
  'Run a JQL query and get back compact rows (key, summary, status, assignee). Use it to find related tickets, sprint contents, or everything matching a label. Read-only.',
  {
    jql: z
      .string()
      .describe('JQL query, e.g. project = PROJ AND status = "In Progress" ORDER BY updated DESC'),
    maxResults: z.number().int().min(1).max(50).optional().default(25)
  },
  async (args) => {
    try {
      const request = buildSearchRequest(requireConfig().baseUrl, args.jql, args.maxResults)
      const raw = await jiraRequest(request.url, {
        method: request.method,
        ...(request.body ? { body: request.body } : {})
      })
      return textResult(
        truncateToolOutput(JSON.stringify(formatSearchRows(raw as never), null, 2), 20_000)
      )
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err))
    }
  }
)

server.tool(
  'add_comment',
  'Post a comment on a Jira issue — a progress note, a summary of what was implemented, or a question for the reporter. Only call it when the user asks you to comment. Cannot change status, assignee or any other field.',
  {
    issueKey: z.string().describe('Jira issue key, e.g. PROJ-123'),
    body: z.string().describe('Comment text. Blank lines separate paragraphs.')
  },
  async (args) => {
    const issueKey = args.issueKey.trim().toUpperCase()
    if (!ISSUE_KEY_RE.test(issueKey)) {
      return textResult(`Invalid issue key "${args.issueKey}". Expected a format like PROJ-123.`)
    }
    if (args.body.trim().length === 0) {
      return textResult('Comment body is empty — nothing was posted.')
    }
    try {
      const cfg = requireConfig()
      await jiraRequest(apiUrl(cfg.baseUrl, `issue/${issueKey}/comment`), {
        method: 'POST',
        body: buildCommentBody(cfg.baseUrl, args.body.trim())
      })
      return textResult(`Comment posted on ${issueKey}: ${issueBrowseUrl(cfg.baseUrl, issueKey)}`)
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err))
    }
  }
)

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(
    `[jira-server] Started (configured=${!!config}${config ? `, host=${new URL(config.baseUrl).host}, mode=${config.authMode}` : ''})`
  )
}

main().catch((err) => {
  console.error('[jira-server] Fatal:', err)
  process.exit(1)
})
