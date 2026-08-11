/**
 * Declarative credential model for external MCP integrations.
 *
 * An integration declares `credentialFields` in EXTERNAL_MCP_INTEGRATIONS; the
 * Integrations UI renders the form from that declaration and the main process
 * maps each field onto the env var handed to the MCP child process.
 *
 * This module is intentionally dependency-free (no Electron, no DB) — it is
 * imported by the renderer, the main process, and by `encrypt-settings-keys`
 * which is transitively loaded by standalone MCP server processes.
 */

import { EXTERNAL_MCP_INTEGRATIONS } from './constants'

export interface CredentialFieldDef {
  /** Field id — settings key becomes `${integrationId}.${key}` */
  key: string
  label: string
  type: 'text' | 'password' | 'url' | 'select'
  /** Env var handed to the MCP child process */
  envVar: string
  /** Secret → encrypted at rest via safeStorage, never returned to the renderer */
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
  options?: { value: string; label: string; description?: string }[]
  /** Conditional visibility, e.g. `{ authMode: ['cloud-token'] }` */
  showWhen?: Record<string, string[]>
}

/** Machine-readable outcome of a connection test — drives targeted UI hints. */
export type IntegrationConnectionCode =
  'ok' | 'auth-failed' | 'not-found' | 'network' | 'cert' | 'proxy' | 'timeout' | 'missing-fields'

export interface IntegrationConnectionResult {
  ok: boolean
  /** Human-safe summary, e.g. "Connected as Jane Doe (Jira Cloud)" */
  message: string
  details?: {
    displayName?: string
    accountId?: string
    deploymentType?: string
    serverVersion?: string
  }
  code?: IntegrationConnectionCode
}

/** Secret-free credential state sent to the renderer. */
export interface IntegrationCredentialStatus {
  /** True when every visible required field has a stored value */
  configured: boolean
  /** Field keys that currently hold a value (secrets included, values excluded) */
  filledKeys: string[]
  /** Non-secret field values — safe to echo back into the form */
  values: Record<string, string>
  /** Field keys that are required, visible, and still empty */
  missingKeys: string[]
}

// ── Pure registry helpers ──

/** Settings key for one credential field, e.g. `jira.apiToken`. */
export function settingsKeyFor(integrationId: string, fieldKey: string): string {
  return `${integrationId}.${fieldKey}`
}

/**
 * Every settings key across the registry that holds a secret.
 * Used by `encryptSettingsKeys` so new integrations are encrypted automatically.
 */
export function listSecretSettingsKeys(): string[] {
  return EXTERNAL_MCP_INTEGRATIONS.flatMap((integration) =>
    (integration.credentialFields ?? [])
      .filter((f) => f.secret)
      .map((f) => settingsKeyFor(integration.id, f.key))
  )
}

/**
 * Whether a field is visible given the current field values.
 * A field with no `showWhen` is always visible; otherwise every declared
 * condition must match.
 */
export function isFieldVisible(
  field: CredentialFieldDef,
  values: Record<string, string | undefined>
): boolean {
  if (!field.showWhen) return true
  return Object.entries(field.showWhen).every(([key, allowed]) =>
    allowed.includes(values[key] ?? '')
  )
}

/**
 * Required field keys that are visible but have no value.
 * Empty array = the integration has everything it needs to start.
 */
export function missingRequiredFields(
  fields: readonly CredentialFieldDef[] | undefined,
  values: Record<string, string | undefined>
): string[] {
  if (!fields) return []
  return fields
    .filter((f) => f.required && isFieldVisible(f, values) && !values[f.key])
    .map((f) => f.key)
}
