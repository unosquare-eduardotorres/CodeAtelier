import { DEFAULT_MODEL_CONFIG } from '../../shared/constants'
import type { ModelAction, ModelOverrides } from '../../shared/types'
import { workspaceRepository } from '../db/repositories'

/**
 * Centralized model resolution service.
 *
 * Resolves the Claude model ID for a given action in a workspace by checking
 * per-action overrides in `settings_json.modelOverrides`, falling back to
 * the hardcoded defaults in `DEFAULT_MODEL_CONFIG`.
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

  /** Fallback: 'generalist:plan' → 'generalist' */
  private fallbackAction(action: ModelAction): string {
    const base = action.split(':')[0] as ModelAction
    return DEFAULT_MODEL_CONFIG[base] ?? DEFAULT_MODEL_CONFIG.generalist
  }
}

export const modelConfigService = new ModelConfigService()
