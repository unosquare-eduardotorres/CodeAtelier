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
   *
   * @param workspacePath - The workspace repo path (or undefined for default)
   * @param action - The model action to resolve
   */
  getModel(workspacePath: string | undefined, action: ModelAction): string {
    if (!workspacePath) return DEFAULT_MODEL_CONFIG[action]

    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action]
  }

  /**
   * Resolves the model ID for a given action using workspace ID.
   * Uses workspace override if set, otherwise returns the default.
   *
   * @param workspaceId - The workspace ID (or undefined for default)
   * @param action - The model action to resolve
   */
  getModelById(workspaceId: string | undefined, action: ModelAction): string {
    if (!workspaceId) return DEFAULT_MODEL_CONFIG[action]

    const settings = workspaceRepository.getSettings(workspaceId)
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action]
  }

  /**
   * Check if an action's model has been overridden from its default.
   */
  isOverridden(workspaceId: string, action: ModelAction): boolean {
    const settings = workspaceRepository.getSettings(workspaceId)
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return action in overrides && overrides[action] !== DEFAULT_MODEL_CONFIG[action]
  }

  /**
   * Reset a single action to its default model.
   */
  resetAction(workspaceId: string, action: ModelAction): void {
    const settings = workspaceRepository.getSettings(workspaceId)
    const overrides = { ...((settings?.modelOverrides ?? {}) as ModelOverrides) }
    delete overrides[action]
    workspaceRepository.updateSettings(workspaceId, { ...settings, modelOverrides: overrides })
  }

  /**
   * Reset ALL model overrides to defaults.
   */
  resetAll(workspaceId: string): void {
    const settings = workspaceRepository.getSettings(workspaceId)
    workspaceRepository.updateSettings(workspaceId, { ...settings, modelOverrides: {} })
  }
}

export const modelConfigService = new ModelConfigService()
