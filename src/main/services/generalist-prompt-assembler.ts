import type { ConversationMode, CostPreference } from '../../shared/types'
import { generalistLogger } from '../logger'
import { PromptBuilder, promptBuilder } from './prompt-builder'
import {
  ASK_QUESTION_PROMPT,
  CHECKPOINT_CONTEXT_GUIDANCE_PROMPT,
  DIRECT_ANSWER_BOOST_PROMPT,
  GIT_CONTEXT_GUIDANCE_PROMPT,
  GITHUB_CONTEXT_GUIDANCE_PROMPT,
  IMAGE_ATTACHMENTS_PROMPT,
  MEMORY_PROTOCOL_PROMPT,
  REPOMAP_GUIDANCE_PROMPT,
  SEMANTIC_SEARCH_GUIDANCE_PROMPT,
  TASK_CONTEXT_GUIDANCE_PROMPT
} from './default-prompts'
import { memoryService } from './memory.service'
import { conversationSpecialistRepository, specialistRepository } from '../db/repositories'

/** Feature flags that affect prompt assembly */
export interface PromptFeatureFlags {
  repomapEnabled: boolean
  semanticSearchEnabled: boolean
  githubConfigured: boolean
}

/** Options for building the system prompt for a turn */
export interface BuildSystemPromptOptions {
  message: string
  hasImages: boolean
  turnCount: number
  workspacePath: string
  workspaceId: string | null
  conversationId: string | null
  mode: ConversationMode
  featureFlags: PromptFeatureFlags
  costPreference: CostPreference
  investigationModeEnabled: boolean
}

/** Options for building the effective user message */
export interface BuildEffectiveMessageOptions {
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: ConversationMode
  investigationModeEnabled: boolean
}

/**
 * Assembles all prompts for the GeneralistService — system prompt, user message prefix,
 * conditional sections, MCP tool guidance, and specialist roster.
 *
 * This class owns the prompt-related state that was previously scattered across
 * GeneralistService fields (memoryContext, specialistRoster, pendingModeSwitch, etc.).
 * These fields don't interact with the stream loop — they're set before send() enters
 * the stream and never read during streaming.
 *
 * ~300 LOC, 7 methods, combined complexity ~45.
 */
export class GeneralistPromptAssembler {
  private readonly log = generalistLogger

  /** Memory context string, cached for switchMode() rebuilds */
  private memoryContext: string | undefined

  /**
   * Strategy β: Specialist roster string, built once per turn by buildSystemPromptForTurn()
   * and injected into the user message on turn 1 only. Removed from system prompt entirely.
   */
  private specialistRoster: string | null = null

  /**
   * Strategy ζ: Cached system prompt snapshot. Rebuilt only when mode changes,
   * conversation changes, or workspace settings update. Eliminates redundant DB queries
   * + disk I/O (stat calls) on every turn.
   */
  private systemPromptSnapshot: string | null = null
  private systemPromptSnapshotMode: ConversationMode | null = null
  private systemPromptSnapshotConversationId: string | null = null

  /** Tracks per-conversation turn count for adaptive prompt budgets. */
  private turnCountMap: Map<string, number> = new Map()

  /** Pending mode switch — when set, the next send() prefixes the message with mode-change context */
  private pendingModeSwitch: { from: ConversationMode; to: ConversationMode } | null = null

  /**
   * Strategy A: Pending context injection — stored here and prepended to the next send() call.
   * Eliminates the expensive injectContext() SDK call that replays the entire session (30-50K tokens).
   * Maps conversationId → context string to inject.
   */
  private pendingContextInjection: Map<string, string> = new Map()

  /**
   * Strategy B: Pending compaction flag — when set, the next send() prefixes with /compact.
   * Eliminates the expensive compact() SDK call that replays the entire session (30-50K tokens).
   * Maps conversationId → compaction prompt.
   */
  private pendingCompaction: Map<string, string> = new Map()

  // ── Turn Count ──

  /** Track turn count per conversation. Returns the new turn number. */
  incrementTurnCount(conversationId: string): number {
    const nextTurn = (this.turnCountMap.get(conversationId) ?? 0) + 1
    this.turnCountMap.set(conversationId, nextTurn)
    return nextTurn
  }

  // ── System Prompt ──

  /**
   * Builds the generalist system prompt for the current turn using:
   * 1) DB-backed base prompt via PromptBuilder
   * 2) adaptive budget tier by turn count
   * 3) optional conditional sections appended after base prompt resolution
   */
  buildSystemPromptForTurn(opts: BuildSystemPromptOptions): string {
    // Strategy C: Memory context is now injected into the user prompt (not system prompt).
    // This keeps the system prompt identical across turns → Claude prompt caching gives
    // a 90% discount on the entire system prompt after the first turn (~1,350 tokens/turn saved).
    if (opts.workspaceId) {
      const memoryBudget = this.getMemoryBudgetForTurn(opts.turnCount, opts.costPreference)
      try {
        const memoryContextForTurn = memoryService.getContextForPrompt(
          opts.workspaceId,
          memoryBudget,
          opts.message
        )
        this.memoryContext = memoryContextForTurn || undefined
      } catch (error) {
        this.log.warn('Failed to refresh filtered memory context; using cached context', error)
      }
    }

    // Strategy ζ: System prompt snapshot — reuse cached prompt when mode + conversation
    // haven't changed. Eliminates DB queries + disk I/O on every turn.
    const canReuseSnapshot =
      this.systemPromptSnapshot &&
      this.systemPromptSnapshotMode === opts.mode &&
      this.systemPromptSnapshotConversationId === opts.conversationId &&
      opts.turnCount > 1 // Always rebuild on turn 1 to pick up latest settings

    const budgetTier = promptBuilder.getGeneralistBudgetTierForTurn(opts.turnCount)
    let promptWithMcpGuidance: string
    if (canReuseSnapshot) {
      promptWithMcpGuidance = this.systemPromptSnapshot!
      this.log.info(
        `[PIPELINE:prompt-snapshot] Reusing cached system prompt (turn ${opts.turnCount}, mode=${opts.mode})`
      )
    } else {
      const basePrompt = promptBuilder.build({
        role: 'generalist',
        mode: opts.mode,
        workspacePath: opts.workspacePath,
        // Strategy C: memoryContext is NO LONGER passed here — it goes into the user prompt
        // via the effectiveMessage prefix in send(). The system prompt stays stable for caching.
        budgetTier
      })

      // Strategy δ: MCP tool guidance sections on turn 1 only.
      promptWithMcpGuidance = this.appendMcpToolGuidance(
        basePrompt,
        opts.turnCount,
        opts.conversationId,
        opts.featureFlags
      )

      // Cache the snapshot for reuse on subsequent turns
      this.systemPromptSnapshot = promptWithMcpGuidance
      this.systemPromptSnapshotMode = opts.mode
      this.systemPromptSnapshotConversationId = opts.conversationId
    }

    // Strategy β: Specialist roster is now injected into the user prompt on turn 1 only.
    this.specialistRoster = this.buildSpecialistRoster(opts.conversationId)

    this.log.info(
      `[PIPELINE:prompt-adaptive] conversationId=${opts.conversationId} turn=${opts.turnCount} budget=${budgetTier} rosterSize=${this.specialistRoster ? this.specialistRoster.split('\n').length : 0}`
    )

    // S8: Prompt size check — warn if approaching model context limits
    const sizeCheck = PromptBuilder.checkPromptSize(promptWithMcpGuidance, opts.message, 'sonnet')
    if (sizeCheck.warning) {
      this.log.warn(
        `[PIPELINE:prompt-size] conversationId=${opts.conversationId} turn=${opts.turnCount} ${sizeCheck.warning}`
      )
    }

    return promptWithMcpGuidance
  }

  // ── Effective User Message ──

  /**
   * Assembles the effective user message by prepending all strategy injections.
   *
   * Injection order (outermost → innermost, i.e. first prepended = outermost wrapper):
   *   1. Strategy A: Pending specialist context
   *   2. Strategy B: Pending compaction
   *   3. Mode switch context
   *   4. Mode indicator for resumed sessions
   *   5. Strategy α: Conditional prefix (memory, images, direct-boost, plan reminder)
   *   6. Strategy β: Specialist roster (turn 1 only)
   *   7. Strategy C: Memory context
   */
  buildEffectiveMessage(opts: BuildEffectiveMessageOptions): string {
    let effectiveMessage = opts.message

    // Strategy A: Prepend any pending context injection.
    const pendingContext = this.pendingContextInjection.get(opts.conversationId)
    if (pendingContext) {
      effectiveMessage = `[Context from prior specialist execution — use this to answer follow-up questions without re-delegating]\n\n${pendingContext}\n\n---\n\n${effectiveMessage}`
      this.pendingContextInjection.delete(opts.conversationId)
      this.log.info(
        `[PIPELINE:lazy-inject] Prepended ${pendingContext.length} chars of specialist context`
      )
    }

    // Strategy B: Prepend any pending compaction.
    const pendingCompact = this.pendingCompaction.get(opts.conversationId)
    if (pendingCompact) {
      effectiveMessage = `${pendingCompact}\n\n---\n\n${effectiveMessage}`
      this.pendingCompaction.delete(opts.conversationId)
      this.log.info('[PIPELINE:lazy-compact] Prepended compaction instruction')
    }

    // Mode switch context — prefix the user's message so the agent
    // knows its permissions changed without clearing the session.
    if (this.pendingModeSwitch) {
      const { from, to } = this.pendingModeSwitch
      const modeLabel = to === 'build' ? 'Build (read + execute)' : 'Plan (read-only)'
      const permissions =
        to === 'build'
          ? 'You now have full permissions to execute commands, run apps, install dependencies, and perform all operational tasks. You can also hand off code changes to specialists.'
          : 'You are now in read-only mode. You can read files, search the codebase, and provide guidance, but you cannot run commands or write files.'
      effectiveMessage = `[Mode switched from ${from} to ${to}. Mode: ${modeLabel}. ${permissions} The conversation history above is still valid — continue from where we left off.]\n\n${opts.message}`
      this.log.info(`Mode switch context injected: ${from} → ${to}`)
      this.pendingModeSwitch = null
    }

    // Mode indicator for resumed sessions.
    if (opts.sessionId) {
      effectiveMessage = `[Current mode: ${opts.mode.toUpperCase()}]\n\n${effectiveMessage}`
    }

    // Strategy α: Conditional prefix (toggles per message content).
    const conditionalPrefix = this.buildConditionalPrefix(
      opts.message,
      opts.hasImages,
      opts.mode,
      opts.investigationModeEnabled
    )
    if (conditionalPrefix) {
      effectiveMessage = `${conditionalPrefix}\n\n---\n\n${effectiveMessage}`
    }

    // Strategy β: Specialist roster on turn 1 only — already in history on turns 2+.
    if (opts.turnCount <= 1 && this.specialistRoster) {
      effectiveMessage = `${this.specialistRoster}\n\n---\n\n${effectiveMessage}`
    }

    // Strategy C: Memory context in user prompt (not system prompt) for cache stability.
    if (this.memoryContext) {
      effectiveMessage = `## Auto Memory\n\n${this.memoryContext}\n\n---\n\n${effectiveMessage}`
    }

    this.log.debug(
      `[PIPELINE:effective-message] conversationId=${opts.conversationId} finalLen=${effectiveMessage.length}`
    )

    return effectiveMessage
  }

  // ── Pending State Management ──

  /** Store pending context injection (Strategy A). Accumulates multiple injections. */
  addPendingContext(conversationId: string, context: string): void {
    const existing = this.pendingContextInjection.get(conversationId)
    if (existing) {
      this.pendingContextInjection.set(conversationId, `${existing}\n\n${context}`)
    } else {
      this.pendingContextInjection.set(conversationId, context)
    }
  }

  /** Get pending context size for logging */
  getPendingContextSize(conversationId: string): number {
    return this.pendingContextInjection.get(conversationId)?.length ?? 0
  }

  /** Store pending compaction instruction (Strategy B) */
  setPendingCompaction(conversationId: string, compactionPrompt: string): void {
    this.pendingCompaction.set(conversationId, compactionPrompt)
  }

  /** Invalidate system prompt snapshot (on mode switch or settings change) */
  invalidateSnapshot(): void {
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null
  }

  /** Set pending mode switch — next buildEffectiveMessage() will prefix the user message */
  setPendingModeSwitch(from: ConversationMode, to: ConversationMode): void {
    this.pendingModeSwitch = { from, to }
  }

  /** Set memory context (called during start()) */
  setMemoryContext(ctx: string | undefined): void {
    this.memoryContext = ctx
  }

  /** Reset all state for a new session */
  resetSession(): void {
    this.memoryContext = undefined
    this.specialistRoster = null
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null
    this.turnCountMap.clear()
    this.pendingModeSwitch = null
    this.pendingContextInjection.clear()
    this.pendingCompaction.clear()
  }

  /** Clear turn count for a specific conversation */
  clearConversation(conversationId: string): void {
    this.turnCountMap.delete(conversationId)
  }

  // ── Private Helpers ──

  /**
   * Scale memory budget by turn count.
   * Turn 1: full budget (memory is fresh context). Turn 3+: reduced (already in history). Turn 6+: zero.
   */
  private getMemoryBudgetForTurn(turnCount: number, costPreference: CostPreference): number {
    // Strategy 9: Memory budget floor — retain 300-500 chars for critical user preferences
    // even in long conversations (turn 4+). Previously dropped to 0, causing the model
    // to forget user preferences and corrections in extended sessions.
    if (costPreference === 'economy') {
      return turnCount <= 1 ? 3000 : turnCount <= 3 ? 1000 : 300
    }
    return turnCount <= 1 ? 5000 : turnCount <= 3 ? 2000 : 500
  }

  /**
   * Strategy α: Build a conditional prefix for the user message.
   * These sections toggle based on the user's message content. Moving them to the user prompt
   * makes the system prompt 100% deterministic per mode → 90% cache discount on every turn.
   */
  private buildConditionalPrefix(
    message: string,
    hasImages: boolean,
    mode: ConversationMode,
    investigationModeEnabled: boolean
  ): string {
    const conditionalSections = promptBuilder.getGeneralistConditionalSections(message, hasImages)
    const sections: string[] = []

    if (conditionalSections.includeAskQuestionPrompt) {
      sections.push(ASK_QUESTION_PROMPT)
    }

    if (conditionalSections.includeMemoryProtocolPrompt) {
      sections.push(MEMORY_PROTOCOL_PROMPT)
    }

    if (conditionalSections.includeImageAttachmentsPrompt) {
      sections.push(IMAGE_ATTACHMENTS_PROMPT)
    }

    // Strategy N: Direct Answer Boost
    if (conditionalSections.includeDirectAnswerBoost) {
      sections.push(DIRECT_ANSWER_BOOST_PROMPT)
    }

    // Strategy ζ: Plan Output Reinforcement
    // In plan mode, ALWAYS remind about emit_plan — every plan-mode response should use it.
    // In build mode, only remind when message explicitly requests a plan.
    const isPlanGenerationRequest =
      /\b(create a plan|draft a plan|propose a plan|make a plan|write a plan|design a plan|plan for|plan to (implement|build|add|create|fix|refactor)|how (would|should|can) (I|we|you)|what('s| is) the (best|right) (way|approach))\b/i.test(
        message
      )
    const planReminderInjected = mode === 'plan' || isPlanGenerationRequest

    if (planReminderInjected) {
      sections.push(
        `[Reminder: Use the emit_plan tool to produce a structured plan. Plain-text plans are not actionable — only tool-emitted plans render as interactive cards.]`
      )
    }

    // Strategy γ: When investigation mode is OFF, inject NO HANDOFF directive.
    // The generalist must answer everything directly — no specialist delegation.
    if (!investigationModeEnabled) {
      sections.push(
        `## NO HANDOFF MODE (Investigation Mode OFF)\n\n` +
          `Do NOT hand off to specialists. Answer everything directly using your own tool access.\n` +
          `If you need to read files, do it yourself. Target ≤5 tool calls.\n` +
          `If you genuinely cannot answer after reading 3-5 files, tell the user:\n` +
          `"I couldn't fully answer this — enable Investigation Mode in settings for a deeper specialist analysis."`
      )
    }

    this.log.info(
      `[PIPELINE:conditional-prefix] ask=${conditionalSections.includeAskQuestionPrompt} memory=${conditionalSections.includeMemoryProtocolPrompt} image=${conditionalSections.includeImageAttachmentsPrompt} directBoost=${conditionalSections.includeDirectAnswerBoost} investigationMode=${investigationModeEnabled} planReminder=${planReminderInjected}`
    )

    return sections.length > 0
      ? `[Contextual guidelines for this message]\n\n${sections.join('\n\n')}`
      : ''
  }

  /**
   * Strategy δ: Append MCP tool guidance sections to system prompt — turn 1 only.
   * These are workspace-stable (don't toggle between turns) so they are safe in the system prompt.
   */
  private appendMcpToolGuidance(
    basePrompt: string,
    turnCount: number,
    conversationId: string | null,
    featureFlags: PromptFeatureFlags
  ): string {
    // Strategy δ: Only inject MCP guidance on turn 1.
    if (turnCount > 1) return basePrompt

    const appendSections: string[] = []

    if (featureFlags.repomapEnabled && !basePrompt.includes('## Code Graph Tools')) {
      appendSections.push(REPOMAP_GUIDANCE_PROMPT)
    }

    if (featureFlags.semanticSearchEnabled && !basePrompt.includes('## Semantic Search')) {
      appendSections.push(SEMANTIC_SEARCH_GUIDANCE_PROMPT)
    }

    if (!basePrompt.includes('## Git Context Tools')) {
      appendSections.push(GIT_CONTEXT_GUIDANCE_PROMPT)
    }

    if (conversationId && !basePrompt.includes('## Task Context Tools')) {
      appendSections.push(TASK_CONTEXT_GUIDANCE_PROMPT)
    }

    if (!basePrompt.includes('## Checkpoint Tools')) {
      appendSections.push(CHECKPOINT_CONTEXT_GUIDANCE_PROMPT)
    }

    if (featureFlags.githubConfigured && !basePrompt.includes('## GitHub Tools')) {
      appendSections.push(GITHUB_CONTEXT_GUIDANCE_PROMPT)
    }

    if (appendSections.length === 0) return basePrompt
    return `${basePrompt}\n\n---\n\n${appendSections.join('\n\n---\n\n')}`
  }

  /**
   * Strategy β: Build specialist roster string for user prompt injection.
   * Returns the roster with compressed format (IDs only), or null if no specialists.
   */
  private buildSpecialistRoster(conversationId: string | null): string | null {
    let activeSpecialists = specialistRepository.findActive()

    if (conversationId) {
      const overrides = conversationSpecialistRepository.findByConversation(conversationId)
      if (overrides.length > 0) {
        const activeSpecialistIds = new Set(
          overrides.filter((o) => o.isActive).map((o) => o.specialistId)
        )
        activeSpecialists = activeSpecialists.filter((s) => activeSpecialistIds.has(s.id))
      }
    }

    const nonCoreSpecialists = activeSpecialists.filter(
      (s) => !['generalist', 'generalist-agent', 'user'].includes(s.agentId)
    )

    if (nonCoreSpecialists.length === 0) return null

    return `Available specialists: ${nonCoreSpecialists.map((s) => s.agentId).join(', ')}`
  }
}
