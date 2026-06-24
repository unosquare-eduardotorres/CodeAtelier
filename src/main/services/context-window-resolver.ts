/**
 * ContextWindowResolver — determines the real context window for a local LLM.
 *
 * The SDK's `maxTokens` reports whatever the backend (oMLX / Ollama) advertises,
 * which can be significantly smaller than the model's actual capability:
 *   - oMLX: deliberately scales down the context window to trigger auto-compact at
 *     a safe threshold (e.g. reports 32K for a 131K model).
 *   - Ollama: defaults to VRAM-based sizing (32K for 24-48GB Macs).
 *
 * Resolution chain (first non-null wins):
 *   1. User override (workspace setting `localContextWindow`)
 *   2. Backend API query (oMLX admin or Ollama ps)
 *   3. Known model table (`RECOMMENDED_LOCAL_MODELS`)
 *   4. Hardcoded fallback (32768)
 */

import { RECOMMENDED_LOCAL_MODELS } from '../../shared/constants'
import type { LocalLLMConfig } from '../../shared/types'
import log from 'electron-log/main'

export class ContextWindowResolver {
  /**
   * Query oMLX for the actual model context window.
   * Tries `/admin/api/models` which may expose context info.
   */
  async queryOmlxContext(config: LocalLLMConfig): Promise<number | null> {
    const baseUrl = `http://${config.localHost}:${config.localPort}`
    try {
      const res = await fetch(`${baseUrl}/admin/api/models`, {
        signal: AbortSignal.timeout(3000)
      })
      if (res.ok) {
        const data = (await res.json()) as {
          models?: { id: string; context_window?: number; max_context_window?: number }[]
        }
        const model = data.models?.find(
          (m) => m.id === config.localModel || config.localModel.includes(m.id)
        )
        // oMLX may expose context_window or max_context_window in model metadata
        if (model?.context_window) return model.context_window
        if (model?.max_context_window) return model.max_context_window
      }
    } catch {
      /* not available — fall through */
    }
    return null
  }

  /**
   * Query Ollama for the actual allocated context window via `/api/ps`.
   */
  async queryOllamaContext(config: LocalLLMConfig): Promise<number | null> {
    const baseUrl = `http://${config.localHost}:${config.localPort}`
    try {
      const res = await fetch(`${baseUrl}/api/ps`, {
        signal: AbortSignal.timeout(3000)
      })
      if (res.ok) {
        const data = (await res.json()) as {
          models?: { name?: string; details?: { context_length?: number } }[]
        }
        const model = data.models?.find((m) => m.name?.includes(config.localModel))
        if (model?.details?.context_length) return model.details.context_length
      }
    } catch {
      /* not available — fall through */
    }
    return null
  }

  /**
   * Look up context window from the known model table.
   */
  fromKnownModels(modelId: string): number | null {
    const match = RECOMMENDED_LOCAL_MODELS.find(
      (m) => m.ollamaId === modelId || m.omlxId === modelId
    )
    return match?.contextWindow ?? null
  }

  /**
   * Full resolution chain.
   *
   * @param config  - Local LLM configuration (backend, host, port, model)
   * @param userOverride - Optional user-specified context window from workspace settings
   * @returns Resolved context window size in tokens
   */
  async resolve(config: LocalLLMConfig, userOverride?: number): Promise<number> {
    // 1. User override wins — user knows best
    if (userOverride && userOverride > 0) {
      log.info(`[ContextWindow] Using user override: ${userOverride}`)
      return userOverride
    }

    // 2. Query backend API
    const backendValue =
      config.backend === 'omlx'
        ? await this.queryOmlxContext(config)
        : await this.queryOllamaContext(config)
    if (backendValue) {
      log.info(`[ContextWindow] From ${config.backend} API: ${backendValue}`)
      return backendValue
    }

    // 3. Known model table (RECOMMENDED_LOCAL_MODELS)
    const knownValue = this.fromKnownModels(config.localModel)
    if (knownValue) {
      log.info(`[ContextWindow] From RECOMMENDED_LOCAL_MODELS: ${knownValue}`)
      return knownValue
    }

    // 4. Fallback — 128K is a safer default for modern models (2025+).
    // Most Qwen/Gemma/Llama class models support at least 128K context.
    // This classifies unknown models as 'medium' tier instead of 'small',
    // avoiding the critical issue where 8K context limit truncates the system prompt.
    log.warn(`[ContextWindow] Unknown model "${config.localModel}", defaulting to 131072`)
    return 131072
  }
}

export const contextWindowResolver = new ContextWindowResolver()
