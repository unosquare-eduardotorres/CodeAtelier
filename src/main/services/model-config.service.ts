import {
  DEFAULT_MODEL_CONFIG,
  GLM_DEFAULT_BASE_URL,
  GLM_DEFAULT_MODEL_ID,
  OLLAMA_DEFAULT_HOST,
  OLLAMA_DEFAULT_PORT,
  OMLX_DEFAULT_PORT
} from '../../shared/constants'
import type {
  ConversationModelSnapshot,
  ExecutorBackend,
  GlmEndpointMode,
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
import { isRoleDisabled } from '../../shared/model-role-binding'
import log from 'electron-log'
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
  /**
   * Base URL for custom/local providers.
   * GLM-1: For cloud/proxied providers this is the user's URL verbatim — the config
   * writer must not normalise or suffix it.
   */
  openCodeBaseUrl?: string
  /** API key for the provider */
  openCodeApiKey?: string
  /** GLM-2: Context limit to declare for custom providers absent from models.dev. */
  openCodeContextLimit?: number
  /** GLM-2: Output limit to declare alongside `openCodeContextLimit`. */
  openCodeOutputLimit?: number
  /**
   * GLM-3: Housekeeping model within the same provider. `''` disables housekeeping;
   * `undefined` uses the provider default.
   */
  openCodeSmallModel?: string | null
}

/** Resolved GLM (Z.ai) connection settings for a workspace. */
export interface GlmConfig {
  endpointMode: GlmEndpointMode
  /** Used VERBATIM — never normalised, never suffixed with /v1. */
  baseUrl: string
  /** Decrypted API key. Optional in proxy mode, where the proxy may inject auth. */
  apiKey?: string
  modelId: string
  /** `''` disables housekeeping entirely; `undefined` means "use the Flash default". */
  smallModelId?: string
  contextLimit?: number
  outputLimit?: number
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

    // Check modelRoles (structured cross-provider path) — Claude only.
    // Match on 'claude' explicitly rather than "not local": with GLM in the union,
    // a negative test would hand a caller expecting a Claude model ID something like
    // 'glm-5.3'. Non-Claude assignments fall through to the Claude default instead.
    const roles = (settings?.modelRoles ?? {}) as ModelRoleMap
    const roleAssignment = roles[action]
    if (roleAssignment?.modelId && roleAssignment.provider === 'claude') {
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

    // Check modelRoles (structured cross-provider path) — Claude only.
    // See getModel() above: an explicit 'claude' match, not "not local".
    const roles = (settings?.modelRoles ?? {}) as ModelRoleMap
    const roleAssignment = roles[action]
    if (roleAssignment?.modelId && roleAssignment.provider === 'claude') {
      return roleAssignment.modelId
    }

    // Legacy modelOverrides
    const overrides = (settings?.modelOverrides ?? {}) as ModelOverrides
    return overrides[action] ?? DEFAULT_MODEL_CONFIG[action] ?? this.fallbackAction(action)
  }

  /**
   * Is an optional quality role switched on for this workspace?
   *
   * Optional roles (peer-review, code-review) are OFF until explicitly bound,
   * and can be explicitly bound off with `{ disabled: true }`. Callers must
   * skip the layer entirely when this returns false — never fall back to a
   * default model, which would silently re-enable a layer the user turned off.
   */
  isRoleEnabled(workspacePath: string | undefined, action: ModelAction): boolean {
    const settings = workspacePath
      ? workspaceRepository.getSettingsByPath(workspacePath)
      : undefined
    return !isRoleDisabled(
      action,
      (settings?.modelRoles ?? undefined) as ModelRoleMap | undefined,
      (settings?.modelOverrides ?? undefined) as ModelOverrides | undefined
    )
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

  /** Check if workspace uses the GLM (Z.ai) provider */
  isGlmProvider(workspacePath: string | undefined): boolean {
    return this.getProvider(workspacePath) === 'glm'
  }

  /**
   * Resolve GLM connection settings for a workspace.
   *
   * The base URL is returned exactly as stored. In proxy mode the API key is
   * genuinely optional — a local proxy commonly injects the Authorization header
   * itself, and demanding a key here would block that setup.
   */
  getGlmConfig(workspacePath: string): GlmConfig {
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const endpointMode = (settings?.glmEndpointMode as GlmEndpointMode) ?? 'zai-coding'
    const smallModel = settings?.glmSmallModel as string | undefined
    return {
      endpointMode,
      baseUrl: (settings?.glmBaseUrl as string) || GLM_DEFAULT_BASE_URL,
      apiKey: decryptSettingsKey(
        settings?.glmApiKey as string | undefined,
        !!settings?.glmApiKeyEncrypted
      ),
      modelId: (settings?.glmModel as string) || GLM_DEFAULT_MODEL_ID,
      smallModelId: smallModel,
      contextLimit: settings?.glmContextLimit as number | undefined,
      outputLimit: settings?.glmOutputLimit as number | undefined
    }
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
   * Derive the executor backend from the workspace's resolved LLM provider.
   * Rule: provider === 'claude' → 'cli'; everything else → 'opencode'.
   * No longer reads settings.executorBackend (was user-configurable, now derived).
   */
  getExecutorBackend(workspacePath: string | undefined): ExecutorBackend {
    if (!workspacePath) return 'cli'
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const provider = settings?.llmProvider ?? 'claude'

    // Log when a stored executorBackend value is being ignored (behavior-change traceability)
    const storedBackend = settings?.executorBackend as string | undefined
    if (storedBackend && storedBackend !== (provider === 'claude' ? 'cli' : 'opencode')) {
      log.info(
        `[getExecutorBackend] Ignoring stored executorBackend='${storedBackend}' — ` +
          `now derived from provider='${provider}' → '${provider === 'claude' ? 'cli' : 'opencode'}'`
      )
    }

    return provider === 'claude' ? 'cli' : 'opencode'
  }

  /**
   * Get OpenCode provider configuration for a workspace.
   * Returns default Anthropic config if no OpenCode settings are configured.
   *
   * Phase 4C: Multi-provider support via OpenCode.
   *
   * GLM-6: `providerOverride` is an *explicit* per-run provider selection (the
   * Grill / Council / Audit provider toggles). Those flows have no conversation
   * row, so without this the config was always resolved from the workspace
   * default — a user picking GLM on a Claude workspace silently ran against
   * Anthropic. The override only replaces provider identity; connection details
   * still come from that provider's live workspace settings.
   */
  getOpenCodeConfig(
    workspacePath: string,
    providerOverride?: LLMProvider
  ): OpenCodeProviderSettings {
    const settings = workspaceRepository.getSettingsByPath(workspacePath)
    const provider = providerOverride ?? settings?.llmProvider

    // GLM: OpenAI-compatible custom provider, reached directly or via a local proxy.
    if (provider === 'glm') {
      const glm = this.getGlmConfig(workspacePath)
      return {
        openCodeProvider: 'glm',
        openCodeModel: glm.modelId,
        openCodeBaseUrl: glm.baseUrl,
        openCodeApiKey: glm.apiKey,
        openCodeContextLimit: glm.contextLimit,
        openCodeOutputLimit: glm.outputLimit,
        openCodeSmallModel: glm.smallModelId
      }
    }

    // If workspace uses local LLM, auto-configure Ollama provider
    if (provider === 'local-llm') {
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

  // 0. Off-binding. Optional roles resolve as disabled unless explicitly bound;
  //    any role can be explicitly bound off. A disabled assignment still carries
  //    a modelId (so the UI can show what was turned off) but callers MUST check
  //    `disabled` and skip the layer rather than run it.
  const disabled = isRoleDisabled(action, modelRoles, modelOverrides)

  // 1. New structured model roles (highest priority)
  if (modelRoles?.[action]) {
    const role = modelRoles[action] as ModelRoleAssignment
    return {
      provider: role.provider,
      modelId: role.modelId,
      localBackend: role.localBackend,
      source: 'roles',
      disabled
    }
  }

  // 2. Legacy per-action overrides (interpreted as the workspace's active provider)
  if (modelOverrides?.[action]) {
    return {
      provider: workspaceProvider,
      modelId: modelOverrides[action],
      localBackend: workspaceProvider === 'local-llm' ? workspaceBackend : undefined,
      source: 'override',
      disabled
    }
  }

  // 3. Direct default
  if (action in DEFAULT_MODEL_CONFIG) {
    return {
      provider: 'claude',
      modelId: DEFAULT_MODEL_CONFIG[action],
      source: 'default',
      disabled
    }
  }

  // 4. Base action fallback (e.g. 'specialist:plan' → 'specialist')
  const base = action.split(':')[0]
  if (base && base in DEFAULT_MODEL_CONFIG) {
    return {
      provider: 'claude',
      modelId: DEFAULT_MODEL_CONFIG[base as ModelAction],
      source: 'fallback',
      disabled
    }
  }

  // 5. Ultimate fallback
  return {
    provider: 'claude',
    modelId: DEFAULT_MODEL_CONFIG['specialist'],
    source: 'fallback',
    disabled
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
    workspaceBackend: (settings.localLlmBackend as LocalLLMBackend) ?? undefined
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
