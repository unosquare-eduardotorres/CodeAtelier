/**
 * ProjectSpecialistRoleAdapter — the **only** chat adapter for workspace
 * sessions. Drives AgentSessionService for every workspace.
 *
 * When a specialist row exists with build_status='ready', uses the
 * LLM-tailored prompt from specialists.prompt. Otherwise falls back to
 * DEFAULT_ARCHITECT_PROMPT — a competent generic identity so the agent
 * works immediately, even before specialist generation completes.
 *
 * Also owns all pending-state management (mode switch, compaction,
 * context injection) previously in the legacy DaVinci adapter.
 */

import type { ConversationMode, ModelAction } from '../../../shared/types'
import { RECOMMENDED_LOCAL_MODELS } from '../../../shared/constants'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterSessionLifecycleCtx
} from '../agent-session.types'
import { getDatabase } from '../../db/index'
import {
  appendMcpToolGuidance,
  buildConditionalPrefix,
  buildModeContextPrefix
} from '../prompt-assembly-helpers'
import {
  DEFAULT_ARCHITECT_PROMPT,
  UNIFIED_MODE_SECTION,
  TONE_STYLE_DIRECTIVES,
  TOOL_PRIORITY_DIRECTIVE
} from '../default-prompts'
import { modelConfigService } from '../model-config.service'
import { promptBuilder } from '../prompt-builder'
import { resolveContextTier } from '../context-management'
import { SystemPromptCache } from '../system-prompt-cache'
import { BaseRoleAdapter } from './base.adapter'

interface SpecialistSnapshot {
  id: string
  agentId: string
  displayName: string
  prompt: string
  buildStatus: string
}

export class ProjectSpecialistRoleAdapter extends BaseRoleAdapter {
  readonly role = 'specialist' as const
  readonly agentId: string
  override readonly supportsEmitPlanRecovery = true

  private readonly workspaceId: string
  private snapshot: SpecialistSnapshot | null = null

  /** Pattern 7: Extracted system-prompt snapshot cache. */
  private readonly promptCache = new SystemPromptCache()

  // ── Pending State ──────────

  /** Pending mode switch — next buildPrompts() prefixes the user message */
  private pendingModeSwitch: { from: ConversationMode; to: ConversationMode } | null = null

  /** Strategy A: Pending context injection per conversation (capped at 8K chars) */
  private static readonly MAX_PENDING_CONTEXT_CHARS = 8000
  private pendingContextInjection: Map<string, string> = new Map()

  /** Strategy B: Pending compaction per conversation */
  private pendingCompaction: Map<string, string> = new Map()

  // ── Goal State (per-conversation, consumed on next send) ────────
  private pendingGoals = new Map<string, { goal: string; mode: 'advisory' | 'enforce' }>()

  constructor(params: { workspaceId: string; agentId?: string }) {
    super()
    this.workspaceId = params.workspaceId
    this.agentId = params.agentId ?? `workspace-specialist-${params.workspaceId}`
  }

  override async onSessionStart(ctx: AdapterSessionLifecycleCtx): Promise<void> {
    this.loadSnapshot()

    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)

    // Pattern 6 / Strategy Λ: Lock MCP flags at session start
    this.lockMcpFlags()
  }

  override refreshFeatureFlags(ctx: AdapterSessionLifecycleCtx): void {
    // Re-read the snapshot — the builder may have updated prompt between sends
    // (skills toggled, prompt rebuilt). Also refresh workspace feature flags.
    this.loadSnapshot()
    // Pattern 2: Centralized workspace feature flag refresh
    this.refreshWorkspaceFeatureFlags(ctx.workspaceId, ctx.workspacePath)
  }

  override onConversationSwitch(_conversationId: string): void {
    // Drop the cached system-prompt — the next buildPrompts() will rebuild
    // with the new conversation context (and re-read CLAUDE.md if it changed).
    this.invalidateSnapshot()
  }

  /**
   * Drop the cached system-prompt assembly. Called by onConversationSwitch
   * and exposed publicly so the session layer can force a rebuild on
   * mode switches or other lifecycle events.
   */
  invalidateSnapshot(): void {
    this.promptCache.invalidate()
    this.invalidateToneCache()
  }

  buildPrompts(ctx: AdapterPromptContext): AdapterPromptResult {
    if (!this.snapshot) this.loadSnapshot()

    // Resolve the identity prompt: use the specialist's tailored prompt if
    // ready, otherwise fall back to the generic architect prompt.
    const identityPrompt = this.resolveIdentityPrompt()

    // Pattern 5: Centralized communication tone resolution
    const communicationTone = this.resolveCommunicationTone(
      ctx.conversationId,
      this.workspaceId,
      ctx.turnCount
    )

    // Local LLM: condensed prompt — skip skills, memory, caching strategies.
    // S5: Inject plan-focused directive with context tier for local plan mode.
    if (modelConfigService.isLocalProvider(ctx.workspacePath)) {
      const localConfig = modelConfigService.getLocalLLMConfig(ctx.workspacePath)
      // F2: Resolve actual context window from RECOMMENDED_LOCAL_MODELS
      const match = RECOMMENDED_LOCAL_MODELS.find(
        (m) => m.ollamaId === localConfig.localModel || m.omlxId === localConfig.localModel
      )
      const contextTier = resolveContextTier(match?.contextWindow ?? 32_768)
      const systemPrompt = promptBuilder.buildLocalPrompt({
        role: 'specialist',
        mode: ctx.mode,
        workspacePath: ctx.workspacePath,
        budgetTier: 'minimal',
        contextTier,
        communicationTone
      })
      return { systemPrompt, effectiveMessage: ctx.message }
    }

    // ── System-prompt assembly with snapshot cache ─────────────────
    // Pattern 1: Centralized model resolution
    const isBuildMode = ctx.mode === 'build' || ctx.mode === 'danger'
    const resolvedModel = this.resolveModel(
      ctx.workspacePath,
      `${this.role}:${isBuildMode ? 'build' : 'plan'}` as ModelAction
    )

    // Pattern 7: SystemPromptCache for snapshot reuse
    const cacheKeys = {
      mode: ctx.mode,
      conversationId: ctx.conversationId,
      tone: communicationTone,
      model: resolvedModel ?? null
    }

    let systemPrompt: string
    if (this.promptCache.isValid(cacheKeys, ctx.turnCount)) {
      systemPrompt = this.promptCache.get()!
    } else {
      const modeSection = UNIFIED_MODE_SECTION
      const claudeMdLayer = ctx.workspacePath
        ? promptBuilder.buildClaudeMdLayer(ctx.workspacePath, ctx.mode)
        : ''
      const layers = [modeSection, identityPrompt]
      const baselineSkills = promptBuilder.skills.buildBaselineSkillsLayer()
      if (baselineSkills) layers.push(baselineSkills)
      if (claudeMdLayer) layers.push(claudeMdLayer)
      // Append communication tone overlay for non-default tones.
      if (communicationTone !== 'default') {
        layers.push(`## Communication Tone Override\n${TONE_STYLE_DIRECTIVES[communicationTone]}`)
      }
      const basePrompt = layers.join('\n\n')
      // Strategy Λ: Use locked flags so MCP guidance matches the mounted tool set.
      const mcpFlags = this.getLockedMcpFlags()
      // Resolve which external MCPs are active — drives prompt guidance injection
      const externalMcpActive = this.resolveExternalMcpActive(
        ctx.workspaceId ?? this.workspaceId,
        ctx.conversationId
      )
      systemPrompt = appendMcpToolGuidance(
        basePrompt,
        ctx.turnCount,
        {
          ...mcpFlags,
          externalMcpActive,
          codeAnalysisEnabled: this.codeAnalysisEnabled
        },
        resolvedModel
      )

      // Ensure Tool Priority directive is present
      if (!systemPrompt.includes('## Tool Priority')) {
        systemPrompt += '\n' + TOOL_PRIORITY_DIRECTIVE
      }
      this.promptCache.set(systemPrompt, cacheKeys)
    }

    // ── Effective message assembly with pending state ─────────────
    let effectiveMessage = `${buildModeContextPrefix(ctx.mode, resolvedModel, ctx.turnCount, ctx.message)}\n\n${ctx.message}`

    // Strategy A: Prepend pending context injection.
    // COMPACT-LOST-01: Read but don't delete — deferred to onSendSuccess().
    const pendingContext = ctx.conversationId
      ? this.pendingContextInjection.get(ctx.conversationId)
      : undefined
    if (pendingContext) {
      effectiveMessage = `[Context from prior specialist execution — use this to answer follow-up questions without re-delegating]\n\n${pendingContext}\n\n---\n\n${effectiveMessage}`
      this.log.info(
        `[PIPELINE:lazy-inject] Prepended ${pendingContext.length} chars of specialist context (pending confirmation)`
      )
    }

    // Strategy B: Prepend pending compaction.
    // COMPACT-LOST-01: Read but don't delete — see onSendSuccess().
    const pendingCompact = ctx.conversationId
      ? this.pendingCompaction.get(ctx.conversationId)
      : undefined
    if (pendingCompact) {
      effectiveMessage = `${pendingCompact}\n\n---\n\n${effectiveMessage}`
      this.log.info('[PIPELINE:lazy-compact] Prepended compaction instruction (pending confirmation)')
    }

    // Mode switch context
    if (this.pendingModeSwitch) {
      const { from, to } = this.pendingModeSwitch
      effectiveMessage = `[Mode switched from ${from} to ${to}. Follow the <mode-context> instructions above.]\n\n${effectiveMessage}`
      this.log.info(`Mode switch context injected: ${from} → ${to}`)
      this.pendingModeSwitch = null
    }

    // User-turn prefix (ASK + MEMORY + IMAGE + DIRECT + plan reminder).
    const conditionalPrefix = buildConditionalPrefix({
      message: ctx.message,
      hasImages: ctx.hasImages,
      mode: ctx.mode,
      turnCount: ctx.turnCount,
      model: resolvedModel,
      postCompaction: !!pendingCompact
    })
    if (conditionalPrefix) {
      effectiveMessage = `${conditionalPrefix}\n\n---\n\n${effectiveMessage}`
    }

    return { systemPrompt, effectiveMessage }
  }

  protected override resolveWorkspaceId(): string | null {
    return this.workspaceId
  }

  override onSessionStop(): void {
    this.snapshot = null
    this.repomapEnabled = true
    this.semanticSearchEnabled = true
    this.githubConfigured = false
    this.unlockMcpFlags()
    this.invalidateSnapshot()
    this.pendingModeSwitch = null
    this.pendingContextInjection.clear()
    this.pendingCompaction.clear()
    this.pendingGoals.clear()
  }

  /** Refresh the cached specialist row from the DB. */
  private loadSnapshot(): void {
    try {
      const db = getDatabase()
      const row = db
        .prepare(
          `SELECT id, agent_id, display_name, prompt, build_status
             FROM specialists WHERE workspace_id = ?`
        )
        .get(this.workspaceId) as
        | {
            id: string
            agent_id: string
            display_name: string
            prompt: string
            build_status: string
          }
        | undefined
      if (!row) {
        this.snapshot = null
        return
      }
      this.snapshot = {
        id: row.id,
        agentId: row.agent_id,
        displayName: row.display_name,
        prompt: row.prompt ?? '',
        buildStatus: row.build_status
      }
    } catch (err) {
      this.log.warn('Failed to load Project Specialist snapshot:', err)
      this.snapshot = null
    }
  }

  /** The workspace this adapter is bound to. */
  getWorkspaceId(): string {
    return this.workspaceId
  }

  /** For debugging / UI: who is this adapter bound to? */
  getSpecialistId(): string | null {
    return this.snapshot?.id ?? null
  }

  getDisplayName(): string | null {
    return this.snapshot?.displayName ?? null
  }

  getBuildStatus(): string | null {
    return this.snapshot?.buildStatus ?? null
  }

  getMode(): ConversationMode {
    return 'plan'
  }

  // ── Goal Condition Methods ──

  /**
   * Queue a /goal condition for the next send on this conversation.
   * Consumed (auto-cleared) by consumeGoalForConversation() during _doSend().
   */
  setGoalCondition(conversationId: string, goal: string, mode: 'advisory' | 'enforce' = 'enforce'): void {
    this.pendingGoals.set(conversationId, { goal, mode })
  }

  /**
   * Read and consume the pending goal for a conversation.
   * Returns null if no goal was queued. One-shot: clears after read.
   */
  consumeGoalForConversation(conversationId: string): { goal: string; mode: 'advisory' | 'enforce' } | null {
    const pending = this.pendingGoals.get(conversationId)
    if (pending) {
      this.pendingGoals.delete(conversationId)
      return pending
    }
    return null
  }

  /**
   * Duck-type compat: getGoalCondition() returns null for ProjectSpecialist.
   * Chat goals are consumed via consumeGoalForConversation() in _doSend,
   * NOT via this method. Blueprint/MPA adapters use getGoalCondition() directly.
   */
  getGoalCondition(): string | null {
    return null
  }

  getGoalMode(): 'advisory' | 'enforce' {
    return 'advisory'
  }

  // ── Pending State Management ──

  /** Queue a mode-switch prefix for the next buildPrompts() call. */
  setPendingModeSwitch(from: ConversationMode, to: ConversationMode): void {
    this.pendingModeSwitch = { from, to }
    this.invalidateSnapshot()
  }

  /** Queue a compaction instruction for the next send(). */
  setPendingCompaction(conversationId: string, prompt: string): void {
    this.pendingCompaction.set(conversationId, prompt)
  }

  /**
   * COMPACT-LOST-01: Confirm pending injections were sent successfully.
   * Called AFTER executeStream() succeeds. If it threw, pending state is preserved.
   */
  onSendSuccess(conversationId: string): void {
    if (this.pendingContextInjection.has(conversationId)) {
      this.pendingContextInjection.delete(conversationId)
      this.log.info('[PIPELINE:lazy-inject] Context injection confirmed consumed')
    }
    if (this.pendingCompaction.has(conversationId)) {
      this.pendingCompaction.delete(conversationId)
      this.log.info('[PIPELINE:lazy-compact] Compaction instruction confirmed consumed')
    }
  }

  /** Store pending context injection (Strategy A). Accumulates with 8K cap. */
  addPendingContext(conversationId: string, context: string): void {
    const existing = this.pendingContextInjection.get(conversationId)
    if (existing) {
      const combined = `${existing}\n\n${context}`
      if (combined.length > ProjectSpecialistRoleAdapter.MAX_PENDING_CONTEXT_CHARS) {
        this.pendingContextInjection.set(
          conversationId,
          combined.slice(-ProjectSpecialistRoleAdapter.MAX_PENDING_CONTEXT_CHARS)
        )
        this.log.warn(
          `[PIPELINE:pending-context-cap] Truncated accumulated context from ${combined.length} to ${ProjectSpecialistRoleAdapter.MAX_PENDING_CONTEXT_CHARS} chars`
        )
      } else {
        this.pendingContextInjection.set(conversationId, combined)
      }
    } else {
      this.pendingContextInjection.set(conversationId, context)
    }
  }

  /** Get pending context size for logging. */
  getPendingContextSize(conversationId: string): number {
    return this.pendingContextInjection.get(conversationId)?.length ?? 0
  }

  /** Clear all per-conversation pending state. */
  clearConversation(conversationId: string): void {
    this.pendingContextInjection.delete(conversationId)
    this.pendingCompaction.delete(conversationId)
    this.pendingGoals.delete(conversationId)
  }

  // ── Private Helpers ──

  /**
   * Resolve the identity prompt to use in the system prompt.
   * - If a specialist row exists and is ready → use its tailored prompt
   * - Otherwise → use DEFAULT_ARCHITECT_PROMPT
   */
  private resolveIdentityPrompt(): string {
    if (this.snapshot?.buildStatus === 'ready' && this.snapshot.prompt) {
      return this.snapshot.prompt
    }
    return DEFAULT_ARCHITECT_PROMPT
  }
}
