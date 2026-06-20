/**
 * Pure-logic functions extracted from workspace.ipc.ts for testability.
 *
 * No Electron, no I/O, no service references.
 */

// ── Workspace Name Validation ────────────────────────────────────────────────

const MAX_WORKSPACE_NAME_LENGTH = 255

export interface WorkspaceNameValidation {
  valid: boolean
  error?: string
}

/**
 * Validate a workspace name.
 */
export function validateWorkspaceName(name: string, channel: string): WorkspaceNameValidation {
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    return {
      valid: false,
      error: `${channel}: workspace name too long (max ${MAX_WORKSPACE_NAME_LENGTH} chars)`
    }
  }
  return { valid: true }
}

// ── Settings Merge ───────────────────────────────────────────────────────────

/**
 * Shallow-merge workspace settings.
 * Returns a new object with updates applied over existing values.
 */
export function mergeWorkspaceSettings<T extends Record<string, unknown>>(
  existing: T,
  updates: Record<string, unknown>
): T {
  return { ...existing, ...updates } as T
}

// ── LLM Provider Change Detection ───────────────────────────────────────────

export interface ProviderChangeResult {
  changed: boolean
  oldProvider: string
  newProvider: string
}

/**
 * Detect whether the LLM provider has changed between old and new settings.
 */
export function detectLlmProviderChange(
  existingSettings: Record<string, unknown>,
  mergedSettings: Record<string, unknown>
): ProviderChangeResult {
  const oldProvider = (existingSettings.llmProvider as string) ?? 'claude'
  const newProvider = (mergedSettings.llmProvider as string) ?? 'claude'
  return {
    changed: oldProvider !== newProvider,
    oldProvider,
    newProvider
  }
}

// ── Auth Mode Validation ─────────────────────────────────────────────────────

const VALID_AUTH_MODES = ['claude-max', 'api-key'] as const

export interface AuthModeValidation {
  valid: boolean
  error?: string
}

/**
 * Validate an auth mode value.
 */
export function validateAuthMode(authMode: string, channel: string): AuthModeValidation {
  if (!(VALID_AUTH_MODES as readonly string[]).includes(authMode)) {
    return { valid: false, error: `${channel}: authMode must be 'claude-max' or 'api-key'` }
  }
  return { valid: true }
}
