/**
 * IPC handlers for external MCP integration credentials.
 *
 * Secrets are one-way: the renderer can write them and ask whether a field is
 * filled, but plaintext values never cross back over the boundary.
 */

import { ipcMain } from 'electron'
import log from 'electron-log/main'
import { IPC_CHANNELS } from '../../shared/constants'
import type {
  IntegrationConnectionResult,
  IntegrationCredentialStatus
} from '../../shared/integration-credentials.types'
import { validateSender } from './validate-sender'
import { requireObject, requireString } from './validate-args'
import {
  clearIntegrationCredentials,
  effectiveCredentialValues,
  findIntegration,
  getCredentialStatus,
  saveIntegrationCredentials
} from '../services/integration-credentials'
import { jiraConfigFromFieldValues, testJiraConnection } from '../services/jira-connection-test'

const integrationsLog = log.scope('integrations-ipc')

/**
 * Extract the `values` payload, keeping only declared field keys with string
 * values. Anything else is dropped rather than persisted into settings_json.
 */
function parseValues(
  args: Record<string, unknown>,
  integrationId: string,
  channel: string
): Record<string, string> {
  const raw = args.values
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${channel}: field 'values' must be a plain object`)
  }

  const integration = findIntegration(integrationId)
  if (!integration?.credentialFields) {
    throw new Error(`${channel}: integration '${integrationId}' has no credential fields`)
  }

  const allowed = new Set(integration.credentialFields.map((f) => f.key))
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) continue
    if (typeof value !== 'string') {
      throw new Error(`${channel}: values.${key} must be a string`)
    }
    values[key] = value
  }
  return values
}

export function registerIntegrationsIpc(): void {
  // ── Save credentials ──
  ipcMain.handle(IPC_CHANNELS.INTEGRATION_SAVE_CREDENTIALS, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.INTEGRATION_SAVE_CREDENTIALS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const integrationId = requireString(args, 'integrationId', ch)
    const values = parseValues(args, integrationId, ch)

    try {
      saveIntegrationCredentials(workspaceId, integrationId, values)
      return getCredentialStatus(workspaceId, integrationId)
    } catch (err) {
      integrationsLog.error(`${ch} failed:`, err)
      throw new Error('Failed to save integration credentials')
    }
  })

  // ── Credential status (secret-free) ──
  ipcMain.handle(
    IPC_CHANNELS.INTEGRATION_GET_CREDENTIAL_STATUS,
    (event, rawArgs: unknown): IntegrationCredentialStatus => {
      validateSender(event)
      const ch = IPC_CHANNELS.INTEGRATION_GET_CREDENTIAL_STATUS
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const integrationId = requireString(args, 'integrationId', ch)
      return getCredentialStatus(workspaceId, integrationId)
    }
  )

  // ── Clear credentials ──
  ipcMain.handle(IPC_CHANNELS.INTEGRATION_CLEAR_CREDENTIALS, (event, rawArgs: unknown) => {
    validateSender(event)
    const ch = IPC_CHANNELS.INTEGRATION_CLEAR_CREDENTIALS
    const args = requireObject(rawArgs, ch)
    const workspaceId = requireString(args, 'workspaceId', ch)
    const integrationId = requireString(args, 'integrationId', ch)
    clearIntegrationCredentials(workspaceId, integrationId)
    return { success: true }
  })

  // ── Test connection ──
  ipcMain.handle(
    IPC_CHANNELS.INTEGRATION_TEST_CONNECTION,
    async (event, rawArgs: unknown): Promise<IntegrationConnectionResult> => {
      validateSender(event)
      const ch = IPC_CHANNELS.INTEGRATION_TEST_CONNECTION
      const args = requireObject(rawArgs, ch)
      const workspaceId = requireString(args, 'workspaceId', ch)
      const integrationId = requireString(args, 'integrationId', ch)

      const integration = findIntegration(integrationId)
      if (!integration?.supportsConnectionTest) {
        return {
          ok: false,
          code: 'missing-fields',
          message: `${integrationId} does not support connection testing.`
        }
      }

      // Unsaved form values win over stored ones so the user can test before
      // saving. Blank entries fall back to the same shell-env-aware view the
      // mount gate and the "Configured" badge use — otherwise a shell-configured
      // integration reads as configured everywhere except here.
      const overlay = parseValues(args, integrationId, ch)
      const merged = { ...effectiveCredentialValues(integration, workspaceId) }
      for (const [key, value] of Object.entries(overlay)) {
        if (value.trim().length > 0) merged[key] = value.trim()
      }

      if (integrationId === 'jira') {
        return testJiraConnection(jiraConfigFromFieldValues(merged))
      }
      return {
        ok: false,
        code: 'missing-fields',
        message: `No connection test implemented for ${integrationId}.`
      }
    }
  )
}
