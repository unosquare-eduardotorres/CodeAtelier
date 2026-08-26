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
import type { LocalLLMBackend } from '../../../../../shared/types'

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
