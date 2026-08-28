/**
 * Pure draft <-> settings mapping for the GLM provider card.
 *
 * Kept out of GlmProviderCard.tsx so the component file exports only a component
 * (Fast Refresh) and so these rules are testable without a DOM — mirrors
 * local-models-draft.ts.
 */

import {
  GLM_DEFAULT_BASE_URL,
  GLM_DEFAULT_MODEL_ID,
  GLM_ENDPOINTS,
  GLM_SMALL_MODEL_ID
} from '../../../../../shared/constants'
import type { GlmEndpointMode, GlmMcpServerId } from '../../../../../shared/types'

export interface GlmDraft {
  endpointMode: GlmEndpointMode
  baseUrl: string
  /** Empty string = leave the stored key untouched. */
  apiKey: string
  model: string
  /** '' disables housekeeping entirely. */
  smallModel: string
  mcpActive: Partial<Record<GlmMcpServerId, boolean>>
}

export const emptyGlmDraft: GlmDraft = {
  endpointMode: 'zai-coding',
  baseUrl: GLM_DEFAULT_BASE_URL,
  apiKey: '',
  model: GLM_DEFAULT_MODEL_ID,
  smallModel: GLM_SMALL_MODEL_ID,
  mcpActive: {}
}

/** Read the persisted GLM settings into a draft. */
export function draftFromSettings(settings: Record<string, unknown>): GlmDraft {
  return {
    endpointMode: (settings.glmEndpointMode as GlmEndpointMode) ?? 'zai-coding',
    baseUrl: (settings.glmBaseUrl as string) ?? GLM_DEFAULT_BASE_URL,
    // The stored key is encrypted and never returned to the renderer — the field
    // always starts blank and only overwrites when the user types something.
    apiKey: '',
    model: (settings.glmModel as string) ?? GLM_DEFAULT_MODEL_ID,
    smallModel: (settings.glmSmallModel as string) ?? GLM_SMALL_MODEL_ID,
    mcpActive: (settings.glmMcpActive as Partial<Record<GlmMcpServerId, boolean>>) ?? {}
  }
}

/**
 * Build the settings patch for a draft.
 *
 * An untouched (blank) API key field is omitted rather than written as `''`, which
 * would wipe a working stored key every time the user saved an unrelated change.
 */
export function settingsFromDraft(draft: GlmDraft): Record<string, unknown> {
  return {
    glmEndpointMode: draft.endpointMode,
    glmBaseUrl: draft.baseUrl.trim(),
    glmModel: draft.model,
    glmSmallModel: draft.smallModel,
    glmMcpActive: draft.mcpActive,
    // `glmApiKeyEncrypted: false` resets the companion flag so the settings writer
    // re-encrypts the new plaintext instead of mistaking it for stored ciphertext.
    ...(draft.apiKey ? { glmApiKey: draft.apiKey, glmApiKeyEncrypted: false } : {})
  }
}

/**
 * Whether a base URL is the pay-as-you-go host.
 * A Coding Plan key is not valid there, and it is the URL Z.ai's public quick-start
 * guide tells you to use — so it earns an explicit warning rather than a 401 later.
 */
export function isPayAsYouGoUrl(baseUrl: string): boolean {
  return baseUrl.trim().replace(/\/+$/, '') === GLM_ENDPOINTS.payAsYouGo
}
