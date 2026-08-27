/**
 * Pure draft model for the Local Models card.
 *
 * The whole card is a single draft — backend tab, connection params, chat model
 * and embedding model. Previously these had three different save behaviours:
 * host/port/apiKey/contextWindow needed an explicit Save, the two model pickers
 * saved instantly, and the backend tab was persisted only as a side effect of
 * the connection form being dirty (so switching oMLX → Ollama on an already-
 * correct port silently never saved the tab).
 *
 * Kept free of React so the dirty/diff rules can be tested directly.
 */

import { OMLX_DEFAULT_PORT } from '../../../../../shared/constants'
import type {
  CommunicationTone,
  LLMProvider,
  LocalLLMBackend,
  ModelAction,
  ModelRoleMap
} from '../../../../../shared/types'

export const LOCAL_MODELS_DEFAULT_HOST = '127.0.0.1'

export interface LocalModelsDraft {
  localLlmBackend: LocalLLMBackend
  localHost: string
  localPort: number
  localApiKey: string
  localContextWindow: number | undefined
  localModel: string
  ollamaEmbeddingModel: string
}

export const DEFAULT_LOCAL_MODEL = 'qwen3.6:35b-a3b-coding-nvfp4'

export function defaultLocalModelsDraft(): LocalModelsDraft {
  return {
    localLlmBackend: 'omlx',
    localHost: LOCAL_MODELS_DEFAULT_HOST,
    localPort: OMLX_DEFAULT_PORT,
    localApiKey: '',
    localContextWindow: undefined,
    localModel: DEFAULT_LOCAL_MODEL,
    ollamaEmbeddingModel: ''
  }
}

export function localModelsDraftsEqual(a: LocalModelsDraft, b: LocalModelsDraft): boolean {
  return (
    a.localLlmBackend === b.localLlmBackend &&
    a.localHost === b.localHost &&
    a.localPort === b.localPort &&
    a.localApiKey === b.localApiKey &&
    a.localContextWindow === b.localContextWindow &&
    a.localModel === b.localModel &&
    a.ollamaEmbeddingModel === b.ollamaEmbeddingModel
  )
}

/**
 * Settings payload containing ONLY the fields that actually changed.
 *
 * Main merges the payload over the existing settings row, so a client-side
 * read-modify-write is not merely redundant — it reverts every key any other
 * page changed since this one loaded its snapshot.
 */
export function changedLocalModelsSettings(
  draft: LocalModelsDraft,
  persisted: LocalModelsDraft
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  if (draft.localLlmBackend !== persisted.localLlmBackend) {
    changed.localLlmBackend = draft.localLlmBackend
  }
  if (draft.localHost !== persisted.localHost) changed.localHost = draft.localHost
  if (draft.localPort !== persisted.localPort) changed.localPort = draft.localPort
  if (draft.localApiKey !== persisted.localApiKey) changed.localApiKey = draft.localApiKey
  if (draft.localContextWindow !== persisted.localContextWindow) {
    // `undefined` would be dropped by structured-clone over IPC — null is the
    // explicit "no override" the main-side merge understands.
    changed.localContextWindow = draft.localContextWindow ?? null
  }
  if (draft.localModel !== persisted.localModel) changed.localModel = draft.localModel
  if (draft.ollamaEmbeddingModel !== persisted.ollamaEmbeddingModel) {
    changed.ollamaEmbeddingModel = draft.ollamaEmbeddingModel
  }
  return changed
}

// ─── Routing draft ──────────────────────────────────

/**
 * The other half of the page: routing, fallback and tone.
 *
 * These used to persist the instant a dropdown changed while the connection
 * fields waited for a Save button — two save models on one page, with no way to
 * tell which control you were looking at. They now share the draft, so one Save
 * covers everything.
 */
export interface RoutingDraft {
  modelRoles: ModelRoleMap
  modelOverrides: Record<string, string>
  fallbackModel: string | undefined
  communicationTone: CommunicationTone
}

export function defaultRoutingDraft(): RoutingDraft {
  return {
    modelRoles: {},
    modelOverrides: {},
    fallbackModel: undefined,
    communicationTone: 'default'
  }
}

/** Structural comparison — role maps are rebuilt on every edit, never mutated. */
function roleMapsEqual(a: ModelRoleMap, b: ModelRoleMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<ModelAction>
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (!x || !y) return false
    if (x.provider !== y.provider || x.modelId !== y.modelId || x.localBackend !== y.localBackend) {
      return false
    }
  }
  return true
}

function overridesEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

export function routingDraftsEqual(a: RoutingDraft, b: RoutingDraft): boolean {
  return (
    a.fallbackModel === b.fallbackModel &&
    a.communicationTone === b.communicationTone &&
    roleMapsEqual(a.modelRoles, b.modelRoles) &&
    overridesEqual(a.modelOverrides, b.modelOverrides)
  )
}

/** The provider the backend reads for anything not routed per-action. */
export function deriveProvider(roles: ModelRoleMap): LLMProvider {
  return roles['specialist:plan']?.provider ?? 'claude'
}

/**
 * Changed routing keys only — same merge contract as the connection payload.
 *
 * `llmProvider` and `localLlmBackend` ride along with a routing change because
 * the backend resolves un-routed work through them; leaving them stale is how a
 * workspace ends up routed to a local model while still reporting `claude`.
 */
export function changedRoutingSettings(
  draft: RoutingDraft,
  persisted: RoutingDraft,
  activeLocalBackend: LocalLLMBackend
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}

  if (!roleMapsEqual(draft.modelRoles, persisted.modelRoles)) {
    changed.modelRoles = draft.modelRoles
    const derived = deriveProvider(draft.modelRoles)
    changed.llmProvider = derived
    if (derived === 'local-llm') changed.localLlmBackend = activeLocalBackend
  }
  if (!overridesEqual(draft.modelOverrides, persisted.modelOverrides)) {
    changed.modelOverrides = draft.modelOverrides
  }
  if (draft.fallbackModel !== persisted.fallbackModel) {
    changed.fallbackModel = draft.fallbackModel ?? null
  }
  if (draft.communicationTone !== persisted.communicationTone) {
    changed.communicationTone = draft.communicationTone
  }

  return changed
}

/**
 * How many *decisions* are unsaved, for the save bar.
 *
 * Counts what the user changed, not what the payload carries: `llmProvider` and
 * `localLlmBackend` are consequences of a routing edit, and counting them would
 * report "3 unsaved changes" for one dropdown.
 */
export function countUnsavedChanges(
  local: { draft: LocalModelsDraft; persisted: LocalModelsDraft },
  routing: { draft: RoutingDraft; persisted: RoutingDraft }
): number {
  let count = Object.keys(changedLocalModelsSettings(local.draft, local.persisted)).length

  if (!roleMapsEqual(routing.draft.modelRoles, routing.persisted.modelRoles)) count++
  else if (!overridesEqual(routing.draft.modelOverrides, routing.persisted.modelOverrides)) count++
  if (routing.draft.fallbackModel !== routing.persisted.fallbackModel) count++
  if (routing.draft.communicationTone !== routing.persisted.communicationTone) count++

  return count
}
