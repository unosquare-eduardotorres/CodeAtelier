/**
 * One readiness value per integration.
 *
 * Readiness used to be spelled out in three unrelated places on the card — a
 * CLI/bundled row, a token badge and a credential warning — which could
 * disagree with each other and with the toggle's own enabled state. Collapsing
 * the row meant there was space for exactly one status, so the rules live here
 * as pure functions instead of inline JSX conditions.
 */
import type { ExternalMcpDefinition } from '../../../../../shared/constants'
import type { IntegrationCredentialStatus } from '../../../../../shared/integration-credentials.types'

export type IntegrationReadiness = 'ready' | 'setup-required' | 'cli-missing' | 'checking'

export interface ReadinessInput {
  integration: Pick<ExternalMcpDefinition, 'bundledServerEntry' | 'credentialFields'>
  cliStatus: { checked: boolean; found: boolean; path?: string }
  workspaceId: string | null
  credentialStatus?: IntegrationCredentialStatus
}

/**
 * Resolution order matters: a missing CLI outranks missing credentials because
 * filling the form would not make the integration usable.
 */
export function deriveReadiness({
  integration,
  cliStatus,
  workspaceId,
  credentialStatus
}: ReadinessInput): IntegrationReadiness {
  // Bundled servers ship with the app — there is nothing to look up on PATH.
  if (!integration.bundledServerEntry) {
    if (!cliStatus.checked) return 'checking'
    if (!cliStatus.found) return 'cli-missing'
  }

  if (integration.credentialFields?.length) {
    // No workspace means no store for credentials and no form to fill.
    if (!workspaceId) return 'setup-required'
    // Never claim "setup required" before the status has actually loaded.
    if (credentialStatus === undefined) return 'checking'
    if (!credentialStatus.configured) return 'setup-required'
  }

  return 'ready'
}

/**
 * Whether the availability toggle must stay locked.
 *
 * Deliberately narrower than `deriveReadiness`: a missing CLI is a warning, not
 * a lock (the user may be about to install it), and an already-enabled
 * integration is never locked — that would trap the user with no way to turn it
 * back off.
 */
export function isToggleBlocked({
  integration,
  workspaceId,
  credentialStatus,
  available
}: Omit<ReadinessInput, 'cliStatus'> & { available: boolean }): boolean {
  if (!integration.credentialFields?.length) return false
  if (available) return false
  if (!workspaceId) return true
  return credentialStatus !== undefined && !credentialStatus.configured
}

export const READINESS_META: Record<
  IntegrationReadiness,
  { label: string; tone: 'success' | 'warning' | 'neutral' }
> = {
  ready: { label: 'Ready', tone: 'success' },
  'setup-required': { label: 'Setup required', tone: 'warning' },
  'cli-missing': { label: 'CLI missing', tone: 'warning' },
  checking: { label: 'Checking…', tone: 'neutral' }
}
