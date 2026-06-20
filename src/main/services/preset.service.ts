/**
 * preset.service — Business logic for LLM preset management.
 *
 * Handles CRUD delegation to the repository, action resolution
 * (preset → DEFAULT_MODEL_CONFIG fallback), validation of constraints
 * (e.g. Chat group provider parity), and summary generation for UI.
 */

import { DEFAULT_MODEL_CONFIG, ACTION_GROUPS } from '../../shared/constants'
import type {
  ActionModelConfig,
  LLMPreset,
  LLMProvider,
  ModelAction
} from '../../shared/types'
import { presetRepository } from '../db/repositories/preset.repository'
import { workspaceRepository } from '../db/repositories/workspace.repository'

// ── Validation ──

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

// ── Service ──

class PresetService {
  // ── CRUD (delegates to repository) ──

  getAllPresets(workspaceId: string): LLMPreset[] {
    return presetRepository.getAll(workspaceId)
  }

  getPreset(presetId: string): LLMPreset | null {
    return presetRepository.getById(presetId)
  }

  createPreset(
    workspaceId: string,
    name: string,
    actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  ): LLMPreset {
    return presetRepository.create(workspaceId, name, actionConfig)
  }

  updatePreset(
    presetId: string,
    changes: { name?: string; actionConfig?: Partial<Record<ModelAction, ActionModelConfig>> }
  ): LLMPreset | null {
    return presetRepository.update(presetId, changes)
  }

  deletePreset(presetId: string): boolean {
    return presetRepository.delete(presetId)
  }

  // ── Workspace default ──

  setWorkspaceDefault(workspaceId: string, presetId: string): void {
    const settings = workspaceRepository.getSettings(workspaceId) ?? {}
    workspaceRepository.updateSettings(workspaceId, {
      ...settings,
      defaultPresetId: presetId
    })
  }

  // ── Resolution ──

  /**
   * Resolve the effective model for a given action, checking:
   * 1. Preset action config (if set)
   * 2. DEFAULT_MODEL_CONFIG fallback
   */
  resolveModel(presetId: string | null, action: ModelAction): string {
    if (presetId) {
      const preset = presetRepository.getById(presetId)
      if (preset?.actionConfig[action]) {
        return preset.actionConfig[action]!.modelId
      }
    }
    return DEFAULT_MODEL_CONFIG[action]
  }

  /**
   * Resolve the provider for a given action from a preset.
   * Returns 'claude' if no preset or no override for that action.
   */
  resolveProvider(presetId: string | null, action: ModelAction): LLMProvider {
    if (presetId) {
      const preset = presetRepository.getById(presetId)
      if (preset?.actionConfig[action]) {
        return preset.actionConfig[action]!.provider
      }
    }
    return 'claude'
  }

  // ── Validation ──

  /**
   * Validate a preset's action config.
   * Rules:
   * - Chat group actions must all use the same provider (providerConstrained)
   */
  validatePreset(
    actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  ): ValidationResult {
    const errors: ValidationError[] = []

    // Check provider parity for constrained groups
    for (const group of ACTION_GROUPS) {
      if (!group.providerConstrained) continue

      const providers = new Set<LLMProvider>()
      for (const action of group.actions) {
        const config = actionConfig[action]
        if (config) {
          providers.add(config.provider)
        }
      }

      if (providers.size > 1) {
        errors.push({
          field: group.id,
          message: `All ${group.label} actions must use the same provider`
        })
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * Generate a human-readable summary of a preset's configuration.
   */
  summarize(preset: LLMPreset): string {
    const configuredActions = Object.keys(preset.actionConfig).length
    const totalActions = Object.keys(DEFAULT_MODEL_CONFIG).length

    if (configuredActions === 0) {
      return preset.name === 'Full Claude'
        ? 'All actions use Claude defaults'
        : 'All actions use default configuration'
    }

    const providers = new Set<string>()
    for (const config of Object.values(preset.actionConfig)) {
      if (config) providers.add(config.provider)
    }

    const providerList = Array.from(providers).join(', ')
    return `${configuredActions}/${totalActions} actions configured (${providerList})`
  }
}

export const presetService = new PresetService()
