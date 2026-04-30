import {
  DEFAULT_MODEL_CONFIG,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT
} from '../../shared/constants'
import type {
  LLMProvider,
  LocalLLMBackend,
  LocalLLMConfig,
  LocalLLMStrategy,
  ModelAction,
  ModelOverrides
} from '../../shared/types'
import { workspaceRepository } from '../db/repositories'

/**
 * Centralized model resolution service.
 *
 * Resolves the Claude model ID for a given action in a workspace by checking
 * per-action overrides in `settings_json.modelOverrides`, falling back to
 * the hardcoded defaults in `DEFAULT_MODEL_CONFIG`.
 *
 * Also provides provider-awareness for local LLM support — resolves the active
 * LLM provider and backend (Ollama / oMLX) configuration for a workspace.
 */
class ModelConfigService {
  /**
   * Resolves the model ID for a given action.
   * Uses workspace override if set, otherwise returns the default.
   * Sub-actions (e.g. 'generalist:plan') fall back to their base action ('generalist').
   *
   * @param workspacePath - The workspace repo path (or undefined for default)
   * @param action - The model action to resolve
   */
  getModel(workspacePath: string | undefined, action: ModelAction): string {
    if (!workspacePath) return DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)

    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)
  }

  /**
   * Resolves the model ID for a given action using workspace ID.
   * Uses workspace override if set, otherwise returns the default.
   * Sub-actions (e.g. 'generalist:plan') fall back to their base action ('generalist').
   *
   * @param workspaceId - The workspace ID (or undefined for default)
   * @param action - The model action to resolve
   */
  getModelById(workspaceId: string | undefined, action: ModelAction): string {
    if (!workspaceId) return DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)

    const settings = workspaceRepository.getSettings(workspaceId)
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)
  }

  // ── Provider awareness ──

  /** Get the LLM provider for a workspace */
  getProvider(workspacePath: string | undefined): LLMProvider {
    if (!workspacePath) return 'claude'
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    return (settings?.llmProvider as LLMProvider) ?? 'claude'
  }

  /** Get full local LLM config for a workspace (supports both Ollama and oMLX backends) */
  getLocalLLMConfig(workspacePath: string): LocalLLMConfig {
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const backend = (settings?.localLlmBackend as LocalLLMBackend) ?? 'ollama'
    const defaultPort = backend === 'omlx' ? OMLX_DEFAULT_PORT : OLLAMA_DEFAULT_PORT
    return {
      provider: (settings?.llmProvider as LLMProvider) ?? 'claude',
      backend,
      // New keys with backward-compat fallback from old Ollama-specific keys
      localModel:
        (settings?.localModel as string) ??
        (settings?.ollamaModel as string) ?? // backward compat
        'qwen3.6:35b-a3b-coding-nvfp4',
      localHost:
        (settings?.localHost as string) ??
        (settings?.ollamaHost as string) ?? // backward compat
        OLLAMA_DEFAULT_HOST,
      localPort:
        (settings?.localPort as number) ??
        (settings?.ollamaPort as number) ?? // backward compat
        defaultPort,
      strategy: (settings?.localLlmStrategy as LocalLLMStrategy) ?? 'sdk-passthrough',
      localApiKey: (settings?.localApiKey as string) || undefined
    }
  }

  /** Build the local LLM base URL from config (works for both Ollama and oMLX) */
  getLocalBaseUrl(config: LocalLLMConfig): string {
    return `http://${config.localHost}:${config.localPort}`
  }

  /**
   * @deprecated Use `getLocalBaseUrl()` instead. Kept for one release cycle.
   */
  getOllamaBaseUrl(config: LocalLLMConfig): string {
    return this.getLocalBaseUrl(config)
  }

  /** Check if workspace uses local LLM */
  isLocalProvider(workspacePath: string | undefined): boolean {
    return this.getProvider(workspacePath) === 'local-llm'
  }

  /** Fallback: 'da-vinci:plan' → 'da-vinci' */
  private fallbackAction(action: ModelAction): string {
    const base = action.split(':')[0] as ModelAction
    return DEFAULT_MODEL_CONFIG[base] ?? DEFAULT_MODEL_CONFIG['da-vinci']
  }
}

export const modelConfigService = new ModelConfigService()
