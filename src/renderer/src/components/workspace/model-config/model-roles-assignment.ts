/**
 * Pure model-option and assignment rules for the routing editor.
 *
 * Extracted from ModelRolesSection so the rule that matters most can be tested
 * without a DOM: which *backend* a local-LLM assignment records.
 *
 * The defect this exists to prevent: `buildAssignment` hardcoded
 * `localBackend: 'omlx'`, so an Ollama user routing Plan to `qwen3:8b` had the
 * assignment written down as oMLX. Nothing in the UI said so, and the routing
 * then resolved against a server the user wasn't running.
 */

import { AVAILABLE_MODELS } from '../../../../../shared/constants'
import type { LLMProvider, LocalLLMBackend, ModelRoleAssignment } from '../../../../../shared/types'

export interface ModelOption {
  id: string
  label: string
  provider: LLMProvider
  group: 'claude' | 'local' | 'glm'
}

/**
 * Claude's catalogue, whatever the local server currently offers for chat, and the
 * GLM catalogue.
 *
 * `glmModels` are the IDs discovered from the GLM endpoint's `/models` (Test
 * Connection). When discovery hasn't run, the caller passes the static fallback list
 * — Z.ai's own docs disagree on model IDs, so a hardcoded list can go stale.
 */
export function buildModelOptions(
  localChatModels: string[],
  glmModels: readonly { id: string; label: string }[] = []
): ModelOption[] {
  const options: ModelOption[] = AVAILABLE_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: 'claude' as const,
    group: 'claude' as const
  }))

  for (const model of localChatModels) {
    options.push({ id: model, label: model, provider: 'local-llm', group: 'local' })
  }

  for (const model of glmModels) {
    options.push({ id: model.id, label: model.label, provider: 'glm', group: 'glm' })
  }

  return options
}

/**
 * Build the persisted assignment for a chosen option.
 *
 * `localBackend` must be the backend the user is *actually* on — it is read
 * back when the role is resolved, so recording the wrong one routes the request
 * to the wrong server.
 */
export function buildAssignment(
  opt: ModelOption,
  localBackend: LocalLLMBackend
): ModelRoleAssignment {
  return {
    provider: opt.provider,
    modelId: opt.id,
    ...(opt.provider === 'local-llm' ? { localBackend } : {})
  }
}

/** Human label for a local backend, used wherever the UI names the server. */
export function localBackendLabel(backend: LocalLLMBackend): string {
  return backend === 'ollama' ? 'Ollama' : 'oMLX'
}
