/**
 * Per-workspace credential storage for external MCP integrations.
 *
 * Values live in the workspace `settings_json` blob under `${integrationId}.${fieldKey}`
 * — the same mechanism the Anthropic API key uses — so there is no schema change.
 * Secret fields are encrypted with Electron's safeStorage before they touch the DB.
 *
 * `resolveIntegrationEnv` is the single choke point every MCP mount path uses to
 * turn stored credentials into the child process environment.
 */

import type { ExternalMcpDefinition } from '../../shared/constants'
import type { IntegrationCredentialStatus } from '../../shared/integration-credentials.types'
import {
  settingsKeyFor,
  isFieldVisible,
  missingRequiredFields
} from '../../shared/integration-credentials.types'
import { EXTERNAL_MCP_INTEGRATIONS } from '../../shared/constants'
import { workspaceRepository } from '../db/repositories/workspace.repository'
import { encryptSettingsKeys, decryptSettingsKey } from '../ipc/encrypt-settings-keys'
import log from 'electron-log/main'

const credLog = log.scope('integration-credentials')

/** Look up an integration definition by id. */
export function findIntegration(integrationId: string): ExternalMcpDefinition | undefined {
  return EXTERNAL_MCP_INTEGRATIONS.find((i) => i.id === integrationId)
}

/**
 * Read every stored credential field for an integration, decrypting secrets.
 * Main-process only — the plaintext values must never cross the IPC boundary.
 */
export function readCredentialValues(
  workspaceId: string,
  integration: ExternalMcpDefinition
): Record<string, string> {
  const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
  const values: Record<string, string> = {}

  for (const field of integration.credentialFields ?? []) {
    const key = settingsKeyFor(integration.id, field.key)
    const raw = settings[key]
    if (typeof raw !== 'string' || raw.length === 0) continue

    const value = field.secret ? decryptSettingsKey(raw, settings[`${key}Encrypted`] === true) : raw
    if (value) values[field.key] = value
  }

  return values
}

/**
 * Persist credential values. An empty string for a field means "leave unchanged"
 * so the renderer can submit the form without ever holding the stored secret.
 */
export function saveIntegrationCredentials(
  workspaceId: string,
  integrationId: string,
  values: Record<string, string>
): void {
  const integration = findIntegration(integrationId)
  if (!integration?.credentialFields) {
    throw new Error(`Unknown integration or no credential fields: ${integrationId}`)
  }

  const existing = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
  const next: Record<string, unknown> = { ...existing }

  for (const field of integration.credentialFields) {
    const incoming = values[field.key]
    if (incoming === undefined) continue

    const key = settingsKeyFor(integration.id, field.key)
    const trimmed = incoming.trim()

    if (trimmed.length === 0) {
      // Secrets: blank means "keep what is stored". Non-secrets: blank clears.
      if (!field.secret) {
        delete next[key]
      }
      continue
    }

    next[key] = trimmed
    // Reset the companion flag so encryptSettingsKeys re-encrypts the new value
    // instead of treating it as already-encrypted ciphertext.
    if (field.secret) next[`${key}Encrypted`] = false
  }

  workspaceRepository.updateSettings(workspaceId, encryptSettingsKeys(next))
  credLog.info(`Saved credentials for ${integrationId} (workspace=${workspaceId})`)
}

/**
 * Remove every stored credential field for an integration, and turn the
 * integration off for the workspace.
 *
 * Leaving it enabled would produce a pill in the chat bar for a server the mount
 * gate now skips — "on" in the UI, silently absent at runtime. Both changes go
 * into one settings write so they cannot diverge.
 */
export function clearIntegrationCredentials(workspaceId: string, integrationId: string): void {
  const integration = findIntegration(integrationId)
  if (!integration?.credentialFields) return

  const settings = workspaceRepository.getSettings(workspaceId) as Record<string, unknown>
  const next: Record<string, unknown> = { ...settings }
  for (const field of integration.credentialFields) {
    const key = settingsKeyFor(integration.id, field.key)
    delete next[key]
    delete next[`${key}Encrypted`]
  }
  next[`${integration.id}Available`] = false

  workspaceRepository.updateSettings(workspaceId, next)
  credLog.info(`Cleared credentials for ${integrationId} (workspace=${workspaceId})`)
}

/**
 * Effective credential values: shell environment first, stored settings on top.
 *
 * The shell layer exists because these integrations were env-var-configured
 * before the credential form existed, and `resolveIntegrationEnv` still honours
 * that. Every gate has to read the same picture, otherwise a user who exports
 * the vars is judged "unconfigured" and the server is never mounted.
 */
export function effectiveCredentialValues(
  integration: ExternalMcpDefinition,
  workspaceId: string | null
): Record<string, string> {
  return withShellEnv(
    integration,
    workspaceId ? readCredentialValues(workspaceId, integration) : {}
  )
}

/** Shell-env values for the declared fields, overlaid with already-read stored values. */
function withShellEnv(
  integration: ExternalMcpDefinition,
  stored: Record<string, string>
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of integration.credentialFields ?? []) {
    const fromShell = process.env[field.envVar]
    if (!fromShell) continue
    // A `select` has a closed value space. The form can only ever produce a
    // declared option, but the shell has no such constraint — and an out-of-range
    // value (e.g. JIRA_AUTH_MODE=PAT) would still count as "set", silently
    // reshaping which fields `isFieldVisible` treats as required and letting the
    // mount gate pass a configuration the server cannot authenticate with.
    if (field.options && !field.options.some((o) => o.value === fromShell)) continue
    values[field.key] = fromShell
  }
  return Object.assign(values, stored)
}

/**
 * Secret-free view of the stored credentials — safe to send to the renderer.
 * Non-secret values are echoed back so the form can pre-fill; secrets are
 * reported only as "filled".
 */
export function getCredentialStatus(
  workspaceId: string,
  integrationId: string
): IntegrationCredentialStatus {
  const integration = findIntegration(integrationId)
  if (!integration?.credentialFields) {
    return { configured: true, filledKeys: [], values: {}, missingKeys: [] }
  }

  const stored = readCredentialValues(workspaceId, integration)
  const values: Record<string, string> = {}
  for (const field of integration.credentialFields) {
    if (!field.secret && stored[field.key]) values[field.key] = stored[field.key]
  }

  // `configured` / `missingKeys` follow the same shell-env-aware view the mount
  // gate uses, so the UI never blocks a toggle the main process would honour.
  // `filledKeys` / `values` stay stored-only — they drive Clear and form pre-fill.
  const missingKeys = missingRequiredFields(
    integration.credentialFields,
    withShellEnv(integration, stored)
  )
  return {
    configured: missingKeys.length === 0,
    filledKeys: Object.keys(stored),
    values,
    missingKeys
  }
}

/**
 * Required credential field keys that are still empty for this workspace.
 * Empty array = the integration can be mounted.
 */
export function missingCredentials(
  integration: ExternalMcpDefinition,
  workspaceId: string | null
): string[] {
  if (!integration.credentialFields?.length) return []
  return missingRequiredFields(
    integration.credentialFields,
    effectiveCredentialValues(integration, workspaceId)
  )
}

/**
 * Build the environment for an integration's MCP child process.
 *
 * Precedence, lowest to highest:
 *   1. `process.env[envKey]` for any declared env key (preserves the original
 *      shell-environment behaviour for users who already export these)
 *   2. Stored per-workspace credential fields
 *   3. `performanceEnv` (app-controlled, never user-supplied)
 */
export function resolveIntegrationEnv(
  integration: ExternalMcpDefinition,
  workspaceId: string | null
): Record<string, string> {
  const env: Record<string, string> = {}

  for (const key of integration.envKeys ?? []) {
    const fromShell = process.env[key]
    if (fromShell) env[key] = fromShell
  }

  if (integration.credentialFields?.length) {
    // Visibility is resolved from the same merged view the value comes from, so a
    // shell-provided discriminator (e.g. JIRA_AUTH_MODE) does not make its own
    // dependent fields look hidden and get deleted.
    const values = effectiveCredentialValues(integration, workspaceId)
    for (const field of integration.credentialFields) {
      // Hidden fields (e.g. `username` while authMode is cloud-token) would
      // otherwise leak a stale value into the child process.
      if (!isFieldVisible(field, values)) {
        delete env[field.envVar]
        continue
      }
      if (values[field.key]) env[field.envVar] = values[field.key]
    }
  }

  if (integration.performanceEnv) Object.assign(env, integration.performanceEnv)

  return env
}

/**
 * Resolve env for every active integration in one pass.
 * Integrations with incomplete credentials are omitted — mounting a server that
 * cannot authenticate stalls session startup on the MCP handshake timeout.
 */
export function resolveActiveIntegrationEnvs(
  externalActive: Record<string, boolean>,
  workspaceId: string | null
): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
    if (!externalActive[integration.id]) continue
    const missing = missingCredentials(integration, workspaceId)
    if (missing.length > 0) {
      credLog.warn(`Skipping ${integration.id} — missing credentials: ${missing.join(', ')}`)
      continue
    }
    result[integration.id] = resolveIntegrationEnv(integration, workspaceId)
  }
  return result
}
