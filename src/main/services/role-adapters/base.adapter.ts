/**
 * BaseRoleAdapter — abstract base class providing centralized default implementations
 * for the AgentRoleAdapter interface.
 *
 * ONE change → ONE place → EVERY adapter inherits.
 *
 * Subclasses only override what differs:
 *   - `buildPrompts()` (always — identity/prompt differs per role)
 *   - `getMcpStrategy()` (if not 'full')
 *   - `resolveWorkspaceId()` (for workspace-scoped adapters)
 *   - `emitDetectedIntents()` (override with no-op for audit/MPA)
 *
 * The interface `AgentRoleAdapter` remains the public contract consumed by
 * AgentSessionService. This base class is the default implementation path.
 */

import type {
  AgentIntent,
  AgentRole,
  CommunicationTone,
  LLMProvider,
  ModelAction
} from '../../../shared/types'
import { EXTERNAL_MCP_INTEGRATIONS, LOCAL_MCP_INTEGRATIONS } from '../../../shared/constants'
import type {
  AdapterIntentContext,
  AdapterMcpContext,
  AdapterMcpResult,
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx,
  AgentRoleAdapter,
  AgentSessionEventName
} from '../agent-session.types'
import type { ControlActionCallbacks } from '../control-actions.tool'
import { intentDetector } from '../intent-detector'
import { conversationRepository, workspaceRepository } from '../../db/repositories'
import { githubService } from '../github.service'
import { chatAgentLogger } from '../../logger'
import { buildWorkspaceMcpConfig } from '../workspace-mcp-config'
import { buildReadOnlyToolConfig, buildNoToolsConfig } from './evaluation-mcp-config'
import { modelConfigService } from '../model-config.service'
import { codeGraphService } from '../code-graph.service'
import { vectorSearchService } from '../vector-search.service'
import { TOOL_PRIORITY_DIRECTIVE } from '../default-prompts'
import { appendMcpToolGuidance, type PromptFeatureFlags } from '../prompt-assembly-helpers'

// ── Types ────────────────────────────────────────────────────────────────

export type McpStrategy = 'full' | 'readonly' | 'none' | 'custom'

// ── Base Class ───────────────────────────────────────────────────────────

export abstract class BaseRoleAdapter implements AgentRoleAdapter {
  abstract readonly role: AgentRole
  abstract readonly agentId: string
  interactionTimeoutMs?: number

  protected readonly log = chatAgentLogger

  // ── Capability flags ───────────────────────────────────────────────
  // Adapters that support the plan-card recovery flow (emit_plan re-issue
  // after a blocked Write/Edit) set this to true.  Blueprint / grill /
  // audit / council adapters inherit false — recovery never fires for them.

  readonly supportsEmitPlanRecovery: boolean = false

  // ── Feature flags (shared across all adapters) ──────────────────────

  protected repomapEnabled = true
  protected semanticSearchEnabled = true
  protected githubConfigured = false
  protected codeAnalysisEnabled = true
  protected processManagerEnabled = true

  // ── Strategy Λ: Locked MCP flags ──────────────────────────────────
  // Snapshotted at onSessionStart() — tool set stays stable for the entire
  // session, ensuring Claude's prompt cache prefix is never broken by a
  // mid-session settings toggle.

  private lockedFlags: {
    repomapEnabled: boolean
    semanticSearchEnabled: boolean
    githubConfigured: boolean
  } | null = null

  // ── Communication tone cache ──────────────────────────────────────

  private cachedTone: CommunicationTone | null = null
  private cachedToneConversationId: string | null = null

  // ── Index-state cache ─────────────────────────────────────────────
  // Resolved per prompt build rather than snapshotted at session start:
  // indexing can finish mid-session, and a start-of-session snapshot would keep
  // telling the model "not indexed" for the rest of the conversation.

  private indexStateCache: {
    workspaceId: string
    at: number
    graph: boolean
    vectors: boolean
  } | null = null

  // ── Lifecycle (overridable, sensible defaults) ──────────────────────

  async onSessionStart(_ctx: AdapterSessionLifecycleCtx): Promise<void> {
    /* no-op — subclasses override */
  }

  refreshFeatureFlags(_ctx: AdapterSessionLifecycleCtx): void {
    /* no-op — subclasses override */
  }

  onConversationSwitch(_conversationId: string): void {
    /* no-op — subclasses override */
  }

  onSessionStop(): void {
    /* no-op — subclasses override */
  }

  // ── Prompts (MUST be implemented per-adapter — identity differs) ────

  abstract buildPrompts(ctx: AdapterPromptContext): AdapterPromptResult

  // ── MCP Config (centralized, strategy-driven) ──────────────────────

  /** Override to change MCP strategy. Default: 'full'. */
  protected getMcpStrategy(_ctx?: AdapterMcpContext): McpStrategy {
    return 'full'
  }

  buildMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    switch (this.getMcpStrategy(ctx)) {
      case 'full':
        return this.buildFullMcpConfig(ctx)
      case 'readonly':
        return this.buildReadOnlyMcpConfig(ctx)
      case 'none':
        return buildNoToolsConfig()
      case 'custom':
        return this.buildCustomMcpConfig(ctx)
    }
  }

  /**
   * Full MCP config — shared by all specialist adapters.
   * Handles: locked flags, external MCP resolution, local MCP overrides.
   */
  protected buildFullMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    const baseMcpFlags = this.getLockedMcpFlags()

    // Resolve external MCP active states (per-conversation toggling)
    const externalMcpActive = this.resolveExternalMcpActive(ctx.workspaceId, ctx.conversationId)

    // Resolve per-chat local MCP active state from conversation overrides
    const localMcpActive = this.resolveLocalMcpActive(ctx.conversationId)

    const result = buildWorkspaceMcpConfig({
      mode: ctx.mode,
      workspacePath: ctx.workspacePath,
      workspaceId: ctx.workspaceId,
      conversationId: ctx.conversationId,
      featureFlags: { ...baseMcpFlags, externalMcpActive, localMcpActive },
      controlCallbacks: ctx.controlCallbacks,
      isLocalProvider: modelConfigService.isLocalProvider(ctx.workspacePath),
      contextTier: ctx.contextTier
    })

    // Propagate code-analysis availability to prompt guidance gating
    this.codeAnalysisEnabled = result.codeAnalysisEnabled
    // Process manager: excluded in plan mode (read-only)
    this.processManagerEnabled = ctx.mode !== 'plan'

    return result
  }

  /**
   * Read-only MCP config — shared by Grill, Council, Audit.
   * Override `getIncludeGitContext()` for local LLM gating.
   */
  protected buildReadOnlyMcpConfig(ctx: AdapterMcpContext): AdapterMcpResult {
    return buildReadOnlyToolConfig({
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      hasWorkspace: !!ctx.workspaceId,
      includeGitContext: this.getIncludeGitContext()
    })
  }

  /** Override for MPA or other custom tool lists. */
  protected buildCustomMcpConfig(_ctx: AdapterMcpContext): AdapterMcpResult {
    return buildNoToolsConfig()
  }

  /** Whether to include git-context tools. Default: true. Override for local LLMs. */
  protected getIncludeGitContext(): boolean {
    return true
  }

  // ── Control Callbacks (centralized, parameterized) ─────────────────

  buildControlCallbacks(_params: {
    conversationId: string | null
    emit: (event: AgentSessionEventName, payload: unknown) => void
    getAccumulatedText: () => string
  }): ControlActionCallbacks {
    return {
      onPlan: () => {
        /* session wraps + emits */
      },
      onAskUser: () => {
        /* session wraps + emits */
      }
    }
  }

  /**
   * Override per adapter: each specialist adapter determines its workspace binding.
   * Returns null for adapters without workspace binding.
   */
  protected resolveWorkspaceId(): string | null {
    return null
  }

  // ── Intent Detection (universal — identical in 6 adapters) ─────────

  emitDetectedIntents(ctx: AdapterIntentContext): void {
    const detectedIntents = intentDetector.detectAll(
      ctx.accumulatedText,
      ctx.controlToolState,
      ctx.mode
    )

    for (const intent of detectedIntents) {
      ctx.emit('intent', intent)
    }

    if (detectedIntents.length === 0) {
      this.log.info(`[PIPELINE:response-path] no-action textLen=${ctx.accumulatedText.length}`)
      ctx.emit('intent', {
        type: 'response',
        content: ctx.accumulatedText
      } as AgentIntent)
    }
  }

  // ── Shared Prompt Helpers ──────────────────────────────────────────

  /**
   * Append Tool Priority + MCP guidance to a base prompt. Single call site.
   * Ensures `## Tool Priority` is present for all tool-equipped adapters.
   */
  protected appendToolGuidance(basePrompt: string, turnCount: number, model?: string): string {
    const flags = this.buildPromptFeatureFlags()
    // Tool Priority is always injected for adapters with tools
    const withPriority =
      this.getMcpStrategy() !== 'none' && !basePrompt.includes('## Tool Priority')
        ? basePrompt + '\n' + TOOL_PRIORITY_DIRECTIVE
        : basePrompt
    return appendMcpToolGuidance(withPriority, turnCount, flags, model)
  }

  /**
   * Build feature flags from current state — ONE place, not 7 copy-pastes.
   * Override in subclasses that need variations (e.g., includeGitContext).
   */
  protected buildPromptFeatureFlags(): PromptFeatureFlags {
    const indexState = this.resolveIndexState(this.resolveWorkspaceId())
    return {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      repomapIndexed: indexState.graph,
      semanticSearchIndexed: indexState.vectors,
      githubConfigured: this.githubConfigured,
      includeGitContext: this.getIncludeGitContext(),
      codeAnalysisEnabled: this.codeAnalysisEnabled,
      processManagerEnabled: this.processManagerEnabled
    }
  }

  /**
   * Whether the workspace actually has persisted code-graph / embedding indexes.
   * Memoized for 60s per workspace so this stays a cheap `SELECT … LIMIT 1`.
   *
   * Fails OPEN (reports indexed) on error — suppressing guidance because a DB
   * probe threw is the worse failure of the two.
   */
  protected resolveIndexState(workspaceId: string | null): { graph: boolean; vectors: boolean } {
    if (!workspaceId) return { graph: true, vectors: true }
    const now = Date.now()
    const cached = this.indexStateCache
    if (cached && cached.workspaceId === workspaceId && now - cached.at < 60_000) {
      return { graph: cached.graph, vectors: cached.vectors }
    }
    try {
      const { graph, vectors } = this.probeIndexState(workspaceId)
      this.indexStateCache = { workspaceId, at: now, graph, vectors }
      return { graph, vectors }
    } catch {
      return { graph: true, vectors: true }
    }
  }

  /** The actual DB probe. Separate method so tests can substitute it. */
  protected probeIndexState(workspaceId: string): { graph: boolean; vectors: boolean } {
    return {
      graph: codeGraphService.hasPersistedIndex(workspaceId),
      vectors: vectorSearchService.hasPersistedIndex(workspaceId)
    }
  }

  // ── Centralized Helpers (Patterns 1-7) ─────────────────────────────

  /**
   * Pattern 1: Resolve the model for prompt verbosity gating.
   * Returns undefined for local LLM providers (local models don't use
   * prompt verbosity — they get condensed prompts unconditionally).
   */
  protected resolveModel(workspacePath: string, action: ModelAction): string | undefined {
    const isLocal = modelConfigService.isLocalProvider(workspacePath)
    return isLocal ? undefined : modelConfigService.getModel(workspacePath, action)
  }

  /**
   * Pattern 2: Read workspace settings for repomap / semantic-search / github flags.
   * Called by onSessionStart() and refreshFeatureFlags() in every adapter.
   */
  protected refreshWorkspaceFeatureFlags(workspaceId: string | null, workspacePath?: string): void {
    if (!workspaceId) return
    try {
      const settings = workspaceRepository.getSettings(workspaceId)
      this.repomapEnabled = settings.repomapEnabled !== false
      this.semanticSearchEnabled = settings.semanticSearchEnabled !== false
      if (workspacePath) {
        this.githubConfigured = githubService.isConfigured(workspaceId)
      }
    } catch {
      /* non-fatal — keep defaults */
    }
  }

  /**
   * Pattern 3: Extend interaction timeout for local LLM providers.
   * Local models are much slower but still productive.
   */
  protected applyLocalLlmTimeout(llmProvider: LLMProvider, extendedMinutes = 45): void {
    if (llmProvider === 'local-llm') {
      this.interactionTimeoutMs = extendedMinutes * 60_000
      this.log.info(`[${this.role}] Using extended timeout (${extendedMinutes} min) for local LLM`)
    }
  }

  /**
   * Pattern 5: Resolve the effective communication tone.
   * Resolution chain: conversation override → workspace default → 'default'.
   * Cached per conversation to avoid DB queries on every turn.
   */
  protected resolveCommunicationTone(
    conversationId: string | null,
    workspaceId: string | null,
    turnCount: number
  ): CommunicationTone {
    if (this.cachedTone && this.cachedToneConversationId === conversationId && turnCount > 1) {
      return this.cachedTone
    }
    let tone: CommunicationTone = 'default'
    try {
      if (conversationId) {
        const conv = conversationRepository.findById(conversationId)
        if (conv?.communicationTone) {
          tone = conv.communicationTone
        }
      }
      if (tone === 'default' && workspaceId) {
        const settings = workspaceRepository.getSettings(workspaceId)
        const wsTone = settings.communicationTone as CommunicationTone | undefined
        if (wsTone && wsTone !== 'default') tone = wsTone
      }
    } catch {
      /* non-fatal — fallback to default tone */
    }
    this.cachedTone = tone
    this.cachedToneConversationId = conversationId
    return tone
  }

  /** Invalidate the cached communication tone (on conversation switch / session stop). */
  protected invalidateToneCache(): void {
    this.cachedTone = null
    this.cachedToneConversationId = null
  }

  /**
   * Pattern 6 — Strategy Λ: Lock MCP flags at session start.
   * Tool set stays stable for the entire session, ensuring Claude's prompt
   * cache prefix is never broken by a mid-session settings toggle.
   */
  protected lockMcpFlags(): void {
    this.lockedFlags = {
      repomapEnabled: this.repomapEnabled,
      semanticSearchEnabled: this.semanticSearchEnabled,
      githubConfigured: this.githubConfigured
    }
    this.log.info(
      `[adapter:lock-mcp-flags] repomap=${this.lockedFlags.repomapEnabled} semantic=${this.lockedFlags.semanticSearchEnabled} github=${this.lockedFlags.githubConfigured}`
    )
  }

  /** Strategy Λ: Unlock MCP flags (on session stop). */
  protected unlockMcpFlags(): void {
    this.lockedFlags = null
  }

  /**
   * Get the locked MCP flags (Strategy Λ). Returns the locked snapshot if
   * available, otherwise falls back to live feature flags.
   */
  protected getLockedMcpFlags(): {
    repomapEnabled: boolean
    semanticSearchEnabled: boolean
    githubConfigured: boolean
  } {
    return (
      this.lockedFlags ?? {
        repomapEnabled: this.repomapEnabled,
        semanticSearchEnabled: this.semanticSearchEnabled,
        githubConfigured: this.githubConfigured
      }
    )
  }

  /**
   * Resolve which external MCPs are active for this chat.
   * Used by both buildPrompts (prompt guidance injection) and buildMcpConfig (tool mounting).
   */
  protected resolveExternalMcpActive(
    workspaceId: string | null,
    conversationId: string | null
  ): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    try {
      const wsSettings = workspaceId ? workspaceRepository.getSettings(workspaceId) : {}
      const conv = conversationId ? conversationRepository.findById(conversationId) : null
      const chatOverrides = conv?.mcpOverrides ?? {}

      this.log.info(
        `[adapter:resolve-external-mcp] workspaceId=${workspaceId} conversationId=${conversationId} ` +
          `wsFound=${!!workspaceId} wsSettingsKeys=${Object.keys(wsSettings)
            .filter((k) => k.includes('Available'))
            .join(',')} ` +
          `convFound=${!!conv} chatOverrides=${JSON.stringify(chatOverrides)}`
      )

      for (const integration of EXTERNAL_MCP_INTEGRATIONS) {
        const wsAvailable = !!wsSettings[`${integration.id}Available`]
        const chatActive = !!chatOverrides[integration.id]
        result[integration.id] = wsAvailable && chatActive
        this.log.info(
          `[adapter:resolve-external-mcp] ${integration.id}: wsAvailable=${wsAvailable} chatActive=${chatActive} → mounted=${result[integration.id]}`
        )
      }
    } catch (err) {
      this.log.error('[adapter:external-mcp] Failed to resolve MCP state:', err)
    }
    return result
  }

  /**
   * Resolve per-chat local MCP active state from conversation overrides.
   */
  protected resolveLocalMcpActive(conversationId: string | null): Record<string, boolean> {
    const localMcpActive: Record<string, boolean> = {}
    try {
      const conv = conversationId ? conversationRepository.findById(conversationId) : null
      const chatOverrides = conv?.mcpOverrides ?? {}
      for (const lm of LOCAL_MCP_INTEGRATIONS) {
        localMcpActive[lm.id] = chatOverrides[lm.id] !== false
      }
    } catch (err) {
      this.log.error('[adapter:local-mcp] Failed to resolve local MCP overrides:', err)
    }
    return localMcpActive
  }
}
