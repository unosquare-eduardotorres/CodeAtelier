/**
 * preset.service — Business logic for LLM preset management.
 *
 * Handles CRUD delegation to the repository, action resolution
 * (preset → DEFAULT_MODEL_CONFIG fallback), validation of constraints
 * (e.g. Chat group provider parity), and summary generation for UI.
 */

import { DEFAULT_MODEL_CONFIG, AVAILABLE_MODELS, ACTION_GROUPS } from '../../shared/constants'
import type {
  ActionModelConfig,
  LLMPreset,
  LLMProvider,
  LocalLLMBackend,
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

  /** Ensure built-in presets exist for a workspace. */
  ensureBuiltIns(workspaceId: string): void {
    presetRepository.ensureBuiltIns(workspaceId)
  }

  /** Get the workspace's default preset. */
  getWorkspaceDefaultPreset(workspaceId: string): LLMPreset | null {
    const settings = workspaceRepository.getSettings(workspaceId)
    if (settings?.defaultPresetId) {
      const preset = presetRepository.getById(settings.defaultPresetId)
      if (preset) return preset
    }
    // Fallback to "Full Claude" built-in
    return presetRepository.getBuiltIn(workspaceId, 'Full Claude')
  }

  /** Set the workspace default preset ID in settings. */
  setWorkspaceDefault(workspaceId: string, presetId: string): void {
    const settings = workspaceRepository.getSettings(workspaceId)
    workspaceRepository.updateSettings(workspaceId, {
      ...settings,
      defaultPresetId: presetId
    })
  }

  // ── Resolution ──

  /**
   * Resolve the effective ActionModelConfig for a given action.
   * Resolution chain:
   *   1. Preset's actionConfig[action] (if set)
   *   2. Base action fallback (e.g. 'da-vinci:plan' → 'da-vinci') in preset
   *   3. DEFAULT_MODEL_CONFIG[action] as Claude provider
   *   4. Base action fallback in DEFAULT_MODEL_CONFIG
   */
  resolveAction(presetId: string | null, action: ModelAction): ActionModelConfig {
    if (presetId) {
      const preset = presetRepository.getById(presetId)
      if (preset?.actionConfig) {
        // Direct match
        if (preset.actionConfig[action]) {
          return preset.actionConfig[action]!
        }
        // Base action fallback (e.g. 'da-vinci:plan' → 'da-vinci')
        const base = action.split(':')[0] as ModelAction
        if (base !== action && preset.actionConfig[base]) {
          return preset.actionConfig[base]!
        }
      }
    }

    // Fallback to default config (Claude provider)
    const modelId =
      DEFAULT_MODEL_CONFIG[action] ??
      DEFAULT_MODEL_CONFIG[action.split(':')[0] as ModelAction] ??
      DEFAULT_MODEL_CONFIG['da-vinci']
    return { provider: 'claude' as LLMProvider, modelId }
  }

  /**
   * Resolve provider for an action.
   */
  resolveProvider(presetId: string | null, action: ModelAction): LLMProvider {
    return this.resolveAction(presetId, action).provider
  }

  /**
   * Resolve executor backend for an action based on its provider.
   * Claude → 'cli', local-llm → 'opencode'
   */
  resolveExecutorBackend(
    presetId: string | null,
    action: ModelAction
  ): 'cli' | 'opencode' {
    const config = this.resolveAction(presetId, action)
    return config.provider === 'local-llm' ? 'opencode' : 'cli'
  }

  /**
   * Get the local backend (ollama/omlx) for an action, if it's local.
   */
  resolveLocalBackend(presetId: string | null, action: ModelAction): LocalLLMBackend | undefined {
    const config = this.resolveAction(presetId, action)
    return config.provider === 'local-llm' ? (config.localBackend ?? 'ollama') : undefined
  }

  // ── Summary ──

  /**
   * Get compact summary for UI display.
   * Returns: "Chat: Opus 4.8 · Blueprint: Gemma 3 · Health: Sonnet"
   */
  getPresetSummary(presetId: string): string {
    const preset = presetRepository.getById(presetId)
    if (!preset) return ''
    if (preset.isBuiltIn && preset.name === 'Full Claude') return 'All actions use Claude defaults'
    if (preset.isBuiltIn && preset.name === 'Full Local') return 'All actions use local LLM'

    const nonAdvancedGroups = ACTION_GROUPS.filter((g) => !g.advanced)
    const parts: string[] = []

    for (const group of nonAdvancedGroups) {
      // Find the "representative" action for the group (first one)
      const representative = group.actions[0]
      if (!representative) continue

      const config = this.resolveAction(presetId, representative)
      const label = this.getModelShortLabel(config)
      parts.push(`${group.label}: ${label}`)
    }

    return parts.join(' · ')
  }

  /** Get a short human-readable label for a model config. */
  private getModelShortLabel(config: ActionModelConfig): string {
    if (config.provider === 'local-llm') {
      // Strip tag from model ID: 'qwen3-coder:30b' → 'Qwen3-Coder'
      const base = config.modelId.split(':')[0]
      return base.charAt(0).toUpperCase() + base.slice(1)
    }
    // Claude model — find in AVAILABLE_MODELS
    const model = AVAILABLE_MODELS.find((m) => m.id === config.modelId)
    return model?.label ?? config.modelId
  }

  // ── Validation ──

  /**
   * Validate a preset config — enforce constraints:
   * - Chat Plan + Build must share provider (within Chat group)
   */
  validatePreset(
    actionConfig: Partial<Record<ModelAction, ActionModelConfig>>
  ): ValidationResult {
    const errors: ValidationError[] = []

    // Chat provider constraint: plan + build actions must share provider
    const chatGroup = ACTION_GROUPS.find((g) => g.providerConstrained && g.id === 'chat')
    if (chatGroup) {
      const planActions = chatGroup.actions.filter((a) => a.includes(':plan'))
      const buildActions = chatGroup.actions.filter((a) => a.includes(':build'))

      const planProviders = new Set(
        planActions.map((a) => actionConfig[a]?.provider).filter(Boolean)
      )
      const buildProviders = new Set(
        buildActions.map((a) => actionConfig[a]?.provider).filter(Boolean)
      )

      // If both have explicit providers set, they must match
      if (planProviders.size > 0 && buildProviders.size > 0) {
        const allChatProviders = new Set([...planProviders, ...buildProviders])
        if (allChatProviders.size > 1) {
          errors.push({
            field: 'chat',
            message: 'Chat Plan and Build actions must use the same provider'
          })
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }
}

export const presetService = new PresetService()
