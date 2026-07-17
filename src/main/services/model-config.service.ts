import {
  DEFAULT_MODEL_CONFIG,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT
} from '../../shared/constants'
import type {
  ConversationModelSnapshot,
  ExecutorBackend,
  LLMProvider,
  LocalLLMBackend,
  LocalLLMConfig,
  LocalLLMStrategy,
  ModelAction,
  ModelOverrides,
  ModelRoleAssignment,
  ModelRoleMap,
  ResolvedAssignment
} from '../../shared/types'
import { workspaceRepository } from '../db/repositories'
import { decryptSettingsKey } from '../ipc/encrypt-settings-keys'

/**
 * Multi-provider configuration — extends workspace settings for Phase 4C.
 *
 * Stored in workspace settings_json under openCode* keys.
 * These settings are only used when executorBackend === 'opencode'.
 */
export interface OpenCodeProviderSettings {
  /** Provider ID (e.g. 'anthropic', 'ollama', 'openai', 'google', 'custom') */
  openCodeProvider: string
  /** Model ID within the provider */
  openCodeModel: string
  /** Base URL for custom/local providers */
  openCodeBaseUrl?: string
  /** API key for the provider */
  openCodeApiKey?: string
}

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
   * Sub-actions (e.g. 'specialist:plan') fall back to their base action ('specialist').
   *
   * @param workspacePath - The workspace repo path (or undefined for default)
   * @param action - The model action to resolve
   */
  getModel(workspacePath: string | undefined, action: ModelAction): string {
    if (!workspacePath) return DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)

    const settings = workspaceRepository.getSettingsByPath(workspacePath)

    // Check modelRoles (structured cross-provider path) — Claude only
    const roles = (settings?.modelRoles ?? {}) as ModelRoleMap
    const roleAssignment = roles[action]
    if (roleAssignment?.modelId && roleAssignment.provider !== 'local-llm') {
      return roleAssignment.modelId
    }

    // Legacy modelOverrides
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)
  }

  /**
   * Resolves the model ID for a given action using workspace ID.
   * Uses workspace override if set, otherwise returns the default.
   * Sub-actions (e.g. 'specialist:plan') fall back to their base action ('specialist').
   *
   * @param workspaceId - The workspace ID (or undefined for default)
   * @param action - The model action to resolve
   */
  getModelById(workspaceId: string | undefined, action: ModelAction): string {
    if (!workspaceId) return DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)

    const settings = workspaceRepository.getSettings(workspaceId)

    // Check modelRoles (structured cross-provider path) — Claude only
    const roles = (settings?.modelRoles ?? {}) as ModelRoleMap
    const roleAssignment = roles[action]
    if (roleAssignment?.modelId && roleAssignment.provider !== 'local-llm') {
      return roleAssignment.modelId
    }

    // Legacy modelOverrides
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
      strategy: (settings?.localLlmStrategy as LocalLLMStrategy) ?? 'default',
      // SEC-04: Decrypt localApiKey (handles both legacy plaintext and encrypted)
      localApiKey: decryptSettingsKey(
        settings?.localApiKey as string | undefined,
        !!settings?.localApiKeyEncrypted
      )
    }
  }

  /** Build the local LLM base URL from config (works for both Ollama and oMLX) */
  getLocalBaseUrl(config: LocalLLMConfig): string {
    // SVC-07: Validate host/port before constructing URL
    const host = config.localHost || 'localhost'
    const port = Number(config.localPort)
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return `http://${host}:${OLLAMA_DEFAULT_PORT}`
    }
    return `http://${host}:${port}`
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

  /**
   * S14: Get the local LLM backend for a workspace.
   * Returns 'omlx' | 'ollama' | undefined (undefined if not a local provider).
   */
  getBackend(workspacePath: string | undefined): LocalLLMBackend | undefined {
    if (!workspacePath || !this.isLocalProvider(workspacePath)) return undefined
    return this.getLocalLLMConfig(workspacePath).backend
  }

  /**
   * Get the executor backend for a workspace.
   * Default: 'cli'. Overridden by workspace settings or provider type.
   */
  getExecutorBackend(workspacePath: string | undefined): ExecutorBackend {
    if (!workspacePath) return 'cli'
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    if (settings?.llmProvider === 'local-llm') return 'opencode'
    // SVC-08: Validate against the union type instead of blind cast
    const raw = settings?.executorBackend as string | undefined
    if (raw === 'cli' || raw === 'opencode') return raw
    return 'cli'
  }

  /**
   * Get OpenCode provider configuration for a workspace.
   * Returns default Anthropic config if no OpenCode settings are configured.
   *
   * Phase 4C: Multi-provider support via OpenCode.
   */
  getOpenCodeConfig(workspacePath: string): OpenCodeProviderSettings {
    const settings = workspaceRepository.getSettingsByPath(workspacePath)

    // If workspace uses local LLM, auto-configure Ollama provider
    if (settings?.llmProvider === 'local-llm') {
      const localConfig = this.getLocalLLMConfig(workspacePath)
      return {
        openCodeProvider: localConfig.backend === 'omlx' ? 'omlx' : 'ollama',
        openCodeModel: localConfig.localModel,
        openCodeBaseUrl: this.getLocalBaseUrl(localConfig),
        openCodeApiKey: localConfig.localApiKey
      }
    }

    return {
      openCodeProvider: (settings?.openCodeProvider as string) ?? 'anthropic',
      openCodeModel: (settings?.openCodeModel as string) ?? 'claude-sonnet-5',
      openCodeBaseUrl: settings?.openCodeBaseUrl as string | undefined,
      // SEC-04: Decrypt openCodeApiKey (handles both legacy plaintext and encrypted)
      openCodeApiKey: decryptSettingsKey(
        settings?.openCodeApiKey as string | undefined,
        !!settings?.openCodeApiKeyEncrypted
      )
    }
  }

  /**
   * Fallback: 'specialist:plan' → 'specialist' → DEFAULT_MODEL_CONFIG.
   */
  private fallbackAction(action: ModelAction): string {
    // SVC-06: Validate that the base portion is a known ModelAction key
    const base = action.split(':')[0]
    if (base && base in DEFAULT_MODEL_CONFIG) {
      return DEFAULT_MODEL_CONFIG[base as ModelAction]
    }
    return DEFAULT_MODEL_CONFIG['specialist']
  }
}

export const modelConfigService = new ModelConfigService()

// ── Pure resolution function ────────────────────────────────────────

/**
 * Resolve the model assignment for a given action using the full fallback chain:
 *
 *   1. modelRoles[action]           → source: 'roles'
 *   2. modelOverrides[action] as Claude  → source: 'override'
 *   3. DEFAULT_MODEL_CONFIG[action]  → source: 'default'
 *   4. DEFAULT_MODEL_CONFIG[base]    → source: 'fallback'
 *   5. DEFAULT_MODEL_CONFIG['specialist'] → source: 'fallback'
 *
 * Pure function — all inputs are explicit. No side effects.
 */
export function resolveAssignment(opts: {
  action: ModelAction
  /** modelRoles from workspace settings_json (new structured path) */
  modelRoles?: ModelRoleMap
  /** Legacy modelOverrides from workspace settings_json */
  modelOverrides?: ModelOverrides
  /** Workspace-level provider (for legacy override interpretation) */
  workspaceProvider?: LLMProvider
  /** Workspace-level local backend */
  workspaceBackend?: LocalLLMBackend
}): ResolvedAssignment {
  const {
    action,
    modelRoles,
    modelOverrides,
    workspaceProvider = 'claude',
    workspaceBackend
  } = opts

  // 1. New structured model roles (highest priority)
  if (modelRoles?.[action]) {
    const role = modelRoles[action] as ModelRoleAssignment
    return {
      provider: role.provider,
      modelId: role.modelId,
      localBackend: role.localBackend,
      source: 'roles'
    }
  }

  // 2. Legacy per-action overrides (interpreted as the workspace's active provider)
  if (modelOverrides?.[action]) {
    return {
      provider: workspaceProvider,
      modelId: modelOverrides[action],
      localBackend: workspaceProvider === 'local-llm' ? workspaceBackend : undefined,
      source: 'override'
    }
  }

  // 3. Direct default
  if (action in DEFAULT_MODEL_CONFIG) {
    return {
      provider: 'claude',
      modelId: DEFAULT_MODEL_CONFIG[action],
      source: 'default'
    }
  }

  // 4. Base action fallback (e.g. 'specialist:plan' → 'specialist')
  const base = action.split(':')[0]
  if (base && base in DEFAULT_MODEL_CONFIG) {
    return {
      provider: 'claude',
      modelId: DEFAULT_MODEL_CONFIG[base as ModelAction],
      source: 'fallback'
    }
  }

  // 5. Ultimate fallback
  return {
    provider: 'claude',
    modelId: DEFAULT_MODEL_CONFIG['specialist'],
    source: 'fallback'
  }
}

/**
 * Build the resolve-options object from workspace settings.
 * Shared between buildConversationModelSnapshot and blueprint snapshot creation.
 */
export function buildResolveOpts(workspaceId: string): {
  modelRoles: ModelRoleMap | undefined
  modelOverrides: ModelOverrides | undefined
  workspaceProvider: LLMProvider
  workspaceBackend: LocalLLMBackend | undefined
} {
  const settings = workspaceRepository.getSettings(workspaceId)

  return {
    modelRoles: (settings.modelRoles ?? undefined) as ModelRoleMap | undefined,
    modelOverrides: (settings.modelOverrides ?? undefined) as ModelOverrides | undefined,
    workspaceProvider: (settings.llmProvider as LLMProvider) ?? 'claude',
    workspaceBackend: (settings.localLlmBackend as LocalLLMBackend) ?? undefined,
  }
}

/**
 * Build a frozen model config snapshot for a conversation.
 * Captures the current workspace model assignments at creation time.
 *
 * @param workspaceId - Workspace to snapshot settings from
 * @param explicitProvider - If provided, overrides the workspace-level provider
 * @param routingOverrides - Per-conversation routing overrides (merged on top of workspace roles)
 */
export function buildConversationModelSnapshot(
  workspaceId: string,
  explicitProvider?: LLMProvider,
  routingOverrides?: Partial<ModelRoleMap>
): ConversationModelSnapshot {
  const resolveOpts = buildResolveOpts(workspaceId)

  // If caller specified a provider override, use it
  if (explicitProvider) {
    resolveOpts.workspaceProvider = explicitProvider
  }

  // Merge per-conversation routing overrides on top of workspace roles
  if (routingOverrides && Object.keys(routingOverrides).length > 0) {
    resolveOpts.modelRoles = {
      ...(resolveOpts.modelRoles ?? {}),
      ...routingOverrides
    }
  }

  return {
    plan: resolveAssignment({ action: 'specialist:plan', ...resolveOpts }),
    build: resolveAssignment({ action: 'specialist:build', ...resolveOpts }),
    background: resolveAssignment({ action: 'haiku', ...resolveOpts }),
    snapshotAt: new Date().toISOString()
  }
}
