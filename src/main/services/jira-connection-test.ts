/**
 * Jira "Test Connection" — verifies URL + credentials before the user enables
 * the integration, so a bad token surfaces here instead of as a silent MCP
 * handshake failure mid-conversation.
 *
 * Uses Electron's `net.fetch` rather than the global fetch on purpose: `net`
 * goes through Chromium's network stack, which inherits the **system proxy
 * configuration** and the **OS certificate store**. That is what makes this work
 * through a corporate VPN proxy and against an on-prem Jira signed by an
 * internal CA — exactly the target deployment.
 */

import { net } from 'electron'
import log from 'electron-log/main'
import type { IntegrationConnectionResult } from '../../shared/integration-credentials.types'
import {
  apiUrl,
  buildHeaders,
  formatCurrentUser,
  isCloudHost,
  mapHttpStatus,
  mapNetworkError,
  type JiraConfig
} from '../mcp-servers/jira-api'

const testLog = log.scope('jira-connection-test')

const TIMEOUT_MS = 10_000

/** Map credential field keys (as declared in the registry) onto a JiraConfig. */
export function jiraConfigFromFieldValues(values: Record<string, string>): JiraConfig {
  const mode = values.authMode
  return {
    baseUrl: values.baseUrl ?? '',
    authMode: mode === 'pat' || mode === 'basic' ? mode : 'cloud-token',
    email: values.email,
    username: values.username,
    apiToken: values.apiToken ?? ''
  }
}

/**
 * GET /rest/api/{2|3}/myself with the mode-appropriate auth header.
 * Never returns or logs the token.
 */
export async function testJiraConnection(config: JiraConfig): Promise<IntegrationConnectionResult> {
  if (!config.baseUrl || !config.apiToken) {
    return {
      ok: false,
      code: 'missing-fields',
      message: 'Enter the Jira URL and an API token before testing the connection.'
    }
  }
  if (config.authMode === 'cloud-token' && !config.email) {
    return {
      ok: false,
      code: 'missing-fields',
      message: 'Jira Cloud requires the Atlassian account email that owns the API token.'
    }
  }
  if (config.authMode === 'basic' && !config.username) {
    return { ok: false, code: 'missing-fields', message: 'Enter the Jira username.' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await net.fetch(apiUrl(config.baseUrl, 'myself'), {
      method: 'GET',
      headers: buildHeaders(config),
      signal: controller.signal
    })

    if (!response.ok) {
      const mapped = mapHttpStatus(response.status, config.baseUrl)
      testLog.warn(`Connection test failed: HTTP ${response.status}`)
      return { ok: false, code: mapped.code, message: mapped.message }
    }

    // Same shaper the panel's "assign to me" uses, so the identity this test
    // reports and the identity a write lands on cannot drift apart.
    const user = formatCurrentUser(await response.json())
    const deploymentType = isCloudHost(config.baseUrl) ? 'Jira Cloud' : 'Jira Server / Data Center'

    return {
      ok: true,
      code: 'ok',
      message: `Connected as ${user.displayName} (${deploymentType})`,
      details: {
        displayName: user.displayName,
        accountId: user.accountId,
        deploymentType
      }
    }
  } catch (err) {
    const mapped = mapNetworkError(err)
    testLog.warn(`Connection test failed: ${mapped.code}`)
    return { ok: false, code: mapped.code, message: mapped.message }
  } finally {
    clearTimeout(timer)
  }
}
