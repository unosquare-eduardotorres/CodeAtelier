import type {
  CommunicationTone,
  ConversationMode,
  CostPreference,
  Specialist
} from '../../shared/types'
import { chatAgentLogger } from '../logger'
import { PromptBuilder, promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import {
  specialistRepository,
  workspaceRepository,
  conversationRepository
} from '../db/repositories'
import {
  appendMcpToolGuidance,
  buildConditionalPrefix,
  buildModeContextPrefix,
  type PromptFeatureFlags
} from './prompt-assembly-helpers'
import { resolveContextTier } from './context-management'
import { modelConfigService } from './model-config.service'
import { RECOMMENDED_LOCAL_MODELS } from '../../shared/constants'
import {
  TOOL_PRIORITY_DIRECTIVE
} from './default-prompts'
import { SystemPromptCache } from './system-prompt-cache'

export type { PromptFeatureFlags }

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
  /** Persona specialist ID for generalist impersonation (null = Da Vinci default) */
  personaSpecialistId?: string | null
  /** Cached persona specialist data for prompt building */
  personaData?: Specialist | null
  /** When true, use condensed prompt assembly for local LLM providers */
  isLocalProvider?: boolean
  /** Resolved model ID — used for prompt verbosity gating (Opus 4.8+ gets lean prompts) */
  model?: string
}

/** Options for building the effective user message */
export interface BuildEffectiveMessageOptions {
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: ConversationMode
  /** Resolved model ID — used for mode block verbosity selection */
  model?: string
}

/**
 * Assembles all prompts for the ChatAgentService — system prompt, user message prefix,
 * conditional sections, and MCP tool guidance.
 *
 * This class owns the prompt-related state that was previously scattered across
 * ChatAgentService fields (memoryContext, pendingModeSwitch, etc.). These fields
 * don't interact with the stream loop — they're set before send() enters the
 * stream and never read during streaming.
 */
export class DaVinciPromptAssembler {
  private readonly log = chatAgentLogger

  /** Memory context string, cached for switchMode() rebuilds */
  private memoryContext: string | undefined

  /**
   * Pattern 7: Extracted system-prompt snapshot cache.
   * Rebuilt only when mode, conversation, tone, or model changes.
   * Feature flags are intentionally NOT part of the cache key (static per session).
   */
  private readonly promptCache = new SystemPromptCache()

  /** Cached communication tone to avoid DB queries on every turn */
  private cachedTone: CommunicationTone | null = null
  private cachedToneConversationId: string | null = null

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

  /** Pending persona switch — when set, the next buildEffectiveMessage() prefixes the message with persona-change context */
  private pendingPersonaSwitch: { specialistId: string | null } | null = null

  /**
   * One-shot signal indicating a Project Specialist has become "ready" for this
   * workspace mid-session. When set, the next buildEffectiveMessage() prepends
   * `[PROJECT SPECIALIST READY: <name>]` so DaVinci can propose the swap via
   * ask_user. Cleared after injection so the proposal fires only once per
   * readiness transition.
   */
  private pendingSpecialistReadySignal: string | null = null

  // ── Turn Count ──

  /** Track turn count per conversation. Returns the new turn number. */
  incrementTurnCount(conversationId: string): number {
    const nextTurn = (this.turnCountMap.get(conversationId) ?? 0) + 1
    this.turnCountMap.set(conversationId, nextTurn)
    return nextTurn
  }

  /**
   * Pre-seed the turn count for a resumed session so that the next
   * `incrementTurnCount` call returns 2+ instead of 1.
   *
   * On app restart the in-memory turnCountMap is empty, but the SDK session
   * is resumed via `resume: sessionId`.  Without seeding, turn-1-only
   * injections (specialist roster, MCP guidance, full memory budget) fire
   * again — duplicating content already in the resumed session's history
   * and confusing the model.
   */
  seedTurnCountForResume(conversationId: string): void {
    if (!this.turnCountMap.has(conversationId)) {
      this.turnCountMap.set(conversationId, 1) // next increment → 2
      this.log.info(
        `[PIPELINE:turn-count-seeded] conversationId=${conversationId} — resumed session, seeded to 1 (next turn=2)`
      )
    }
  }

  // ── System Prompt ──

  /**
   * Builds the generalist system prompt for the current turn using:
   * 1) DB-backed base prompt via PromptBuilder
   * 2) adaptive budget tier by turn count
   * 3) optional conditional sections appended after base prompt resolution
   */
  buildSystemPromptForTurn(opts: BuildSystemPromptOptions): string {
    // ── Resolve effective communication tone (cached to skip DB queries on turns 2+) ──
    // Resolution chain: conversation override → workspace default → 'default'
    // Tone rarely changes mid-session — reuse cached value when conversation hasn't changed.
    let communicationTone: CommunicationTone
    if (
      this.cachedTone &&
      this.cachedToneConversationId === opts.conversationId &&
      opts.turnCount > 1
    ) {
      communicationTone = this.cachedTone
    } else {
      communicationTone = 'default'
      try {
        if (opts.conversationId) {
          const conv = conversationRepository.findById(opts.conversationId)
          if (conv?.communicationTone) {
            communicationTone = conv.communicationTone
          }
        }
        if (communicationTone === 'default' && opts.workspaceId) {
          const settings = workspaceRepository.getSettings(opts.workspaceId)
          const wsTone = settings.communicationTone as CommunicationTone | undefined
          if (wsTone && wsTone !== 'default') communicationTone = wsTone
        }
      } catch (e) {
        chatAgentLogger.debug('[prompt] Communication tone resolution failed (non-fatal):', e)
      }
      this.cachedTone = communicationTone
      this.cachedToneConversationId = opts.conversationId
    }

    // Local LLM: condensed prompt — skip memory/skills/caching strategies.
    // S5: Inject plan-focused directive with context tier for local plan mode.
    if (opts.isLocalProvider) {
      // Resolve context tier from known models for plan directive budgeting
      let contextTier: import('./context-management').ContextWindowTier | undefined
      if (opts.mode === 'plan' && opts.workspacePath) {
        try {
          const localConfig = modelConfigService.getLocalLLMConfig(opts.workspacePath)
          const match = RECOMMENDED_LOCAL_MODELS.find(
            (m) => m.ollamaId === localConfig.localModel || m.omlxId === localConfig.localModel
          )
          contextTier = resolveContextTier(match?.contextWindow ?? 32_768)
        } catch (e) {
          chatAgentLogger.debug('[prompt] Context tier resolution failed, using small fallback:', e)
          contextTier = 'small'
        }
      }
      return promptBuilder.buildLocalPrompt({
        role: 'da-vinci',
        mode: opts.mode,
        workspacePath: opts.workspacePath,
        budgetTier: 'minimal',
        contextTier,
        communicationTone
      })
    }

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

    // Pattern 7: SystemPromptCache for snapshot reuse
    const cacheKeys = {
      mode: opts.mode,
      conversationId: opts.conversationId,
      tone: communicationTone,
      model: opts.model ?? null
    }
    const canReuseSnapshot = this.promptCache.isValid(cacheKeys, opts.turnCount)

    const budgetTier = promptBuilder.getGeneralistBudgetTierForTurn(opts.turnCount)
    let promptWithMcpGuidance: string
    if (canReuseSnapshot) {
      promptWithMcpGuidance = this.promptCache.get()!
      this.log.info(
        `[PIPELINE:prompt-snapshot] Reusing cached system prompt (turn ${opts.turnCount}, mode=${opts.mode}, tone=${communicationTone})`
      )
    } else {
      const basePrompt = promptBuilder.build({
        role: 'da-vinci',
        mode: opts.mode,
        workspacePath: opts.workspacePath,
        // Strategy C: memoryContext is NO LONGER passed here — it goes into the user prompt
        // via the effectiveMessage prefix in send(). The system prompt stays stable for caching.
        budgetTier,
        // Persona fields — Layer 0 injection when generalist is impersonating a specialist
        personaSpecialistId: opts.personaSpecialistId,
        personaPrompt: opts.personaData?.prompt,
        personaSkills: opts.personaData
          ? specialistRepository.getSkills(opts.personaData.id)
          : undefined,
        personaSkillOverrides: undefined,
        communicationTone,
        model: opts.model
      })

      // Strategy δ: MCP tool guidance sections on turn 1 only.
      promptWithMcpGuidance = appendMcpToolGuidance(basePrompt, opts.turnCount, opts.featureFlags, opts.model)

      // Ensure Tool Priority directive is present (appendMcpToolGuidance only adds Code Graph guidance)
      if (!promptWithMcpGuidance.includes('## Tool Priority')) {
        promptWithMcpGuidance += '\n' + TOOL_PRIORITY_DIRECTIVE
      }

      // Cache the snapshot for reuse on subsequent turns
      this.promptCache.set(promptWithMcpGuidance, cacheKeys)
    }

    // Diagnostic: hash the system prompt on cache misses to verify stability.
    // If the hash differs between turns, prompt caching will miss.
    if (!canReuseSnapshot) {
      const promptHash = Buffer.from(promptWithMcpGuidance).toString('base64').slice(0, 12)
      this.log.info(
        `[PIPELINE:prompt-hash] turn=${opts.turnCount} hash=${promptHash} reused=false`
      )
    }

    this.log.info(
      `[PIPELINE:prompt-adaptive] conversationId=${opts.conversationId} turn=${opts.turnCount} budget=${budgetTier}`
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
   *   1. `<mode-context>` block (always — current mode instructions)
   *   2. Strategy A: Pending specialist context (consumed on use)
   *   3. Strategy B: Pending compaction (consumed on use)
   *   4. Mode switch context (one-shot)
   *   5. Mode indicator for resumed sessions
   *   6. Strategy α: Conditional prefix (ask_user, memory protocol, images, direct-boost, plan reminder)
   *   7. Strategy β: Specialist roster (turn 1 only)
   *   8. Strategy C: Memory context (full on turns 1-2, feedback-only on turns 3+)
   *
   * @param opts.message - Raw user message text
   * @param opts.conversationId - Conversation ID for per-conversation state lookup
   * @param opts.hasImages - Whether the message includes image attachments
   * @param opts.turnCount - Current turn number (1-indexed)
   * @param opts.sessionId - SDK session ID (undefined on first turn)
   * @param opts.mode - Current conversation mode (plan/build/danger)
   * @param opts.model - Resolved model ID for lean/full verbosity gating
   * @returns Fully-assembled effective message string with all injections prepended
   */
  buildEffectiveMessage(opts: BuildEffectiveMessageOptions): string {
    let effectiveMessage = opts.message

    // Pattern 8: Centralized mode-context prefix
    effectiveMessage = `${buildModeContextPrefix(opts.mode, opts.model)}\n\n${effectiveMessage}`

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
      effectiveMessage = `[Mode switched from ${from} to ${to}. Follow the <mode-context> instructions above.]\n\n${effectiveMessage}`
      this.log.info(`Mode switch context injected: ${from} → ${to}`)
      this.pendingModeSwitch = null
    }

    // Persona switch context — prefix the user's message so the agent
    // knows its identity changed without clearing the session.
    if (this.pendingPersonaSwitch) {
      const name = this.pendingPersonaSwitch.specialistId
        ? (specialistRepository.findById(this.pendingPersonaSwitch.specialistId)?.displayName ??
          'specialist')
        : 'Da Vinci'
      effectiveMessage = `[PERSONA SWITCH] You are now operating as ${name}. Your domain expertise and identity have been updated in the system prompt. Continue the conversation with this new perspective.\n\n---\n\n${effectiveMessage}`
      this.pendingPersonaSwitch = null
    }

    // Specialist-ready signal — one-shot injection consumed after first use.
    // DaVinci's prompt instructs it to call ask_user with a swap proposal when
    // it sees this sentinel. Fires only once per readiness transition.
    if (this.pendingSpecialistReadySignal) {
      effectiveMessage = `[PROJECT SPECIALIST READY: ${this.pendingSpecialistReadySignal}]\n\n${effectiveMessage}`
      this.pendingSpecialistReadySignal = null
    }

    // Mode indicator for resumed sessions.
    if (opts.sessionId) {
      effectiveMessage = `[Current mode: ${opts.mode.toUpperCase()}]\n\n${effectiveMessage}`
    }

    // Strategy α: Conditional prefix (toggles per message content).
    const conditionalPrefix = buildConditionalPrefix({
      message: opts.message,
      hasImages: opts.hasImages,
      mode: opts.mode,
      turnCount: opts.turnCount,
      model: opts.model
    })
    if (conditionalPrefix) {
      effectiveMessage = `${conditionalPrefix}\n\n---\n\n${effectiveMessage}`
    }

    // Strategy C: Memory context in user prompt (not system prompt) for cache stability.
    // Turns 3+: memory is already in history — only inject critical feedback corrections.
    if (this.memoryContext) {
      if (opts.turnCount <= 2) {
        effectiveMessage = `## Auto Memory\n\n${this.memoryContext}\n\n---\n\n${effectiveMessage}`
      } else {
        const feedbackOnly = this.extractFeedbackMemories(this.memoryContext)
        if (feedbackOnly) {
          effectiveMessage = `[Memory: ${feedbackOnly}]\n\n${effectiveMessage}`
        }
      }
    }

    this.log.debug(
      `[PIPELINE:effective-message] conversationId=${opts.conversationId} finalLen=${effectiveMessage.length}`
    )

    return effectiveMessage
  }

  // ── Pending State Management ──

  /**
   * Store pending context injection (Strategy A). Accumulates multiple injections
   * but caps total size to MAX_PENDING_CONTEXT_CHARS (~2K tokens) to prevent
   * unbounded growth if multiple specialist executions inject context.
   * When the cap is exceeded, the oldest content is trimmed (keeps the tail).
   */
  private static readonly MAX_PENDING_CONTEXT_CHARS = 8000

  addPendingContext(conversationId: string, context: string): void {
    const existing = this.pendingContextInjection.get(conversationId)
    if (existing) {
      const combined = `${existing}\n\n${context}`
      if (combined.length > DaVinciPromptAssembler.MAX_PENDING_CONTEXT_CHARS) {
        // Keep the most recent content (tail) when over budget
        this.pendingContextInjection.set(
          conversationId,
          combined.slice(-DaVinciPromptAssembler.MAX_PENDING_CONTEXT_CHARS)
        )
        this.log.warn(
          `[PIPELINE:pending-context-cap] Truncated accumulated context from ${combined.length} to ${DaVinciPromptAssembler.MAX_PENDING_CONTEXT_CHARS} chars`
        )
      } else {
        this.pendingContextInjection.set(conversationId, combined)
      }
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
    this.promptCache.invalidate()
    // Also invalidate tone cache so next turn re-reads from DB
    this.cachedTone = null
    this.cachedToneConversationId = null
  }

  /** Set pending mode switch — next buildEffectiveMessage() will prefix the user message */
  setPendingModeSwitch(from: ConversationMode, to: ConversationMode): void {
    this.pendingModeSwitch = { from, to }
  }

  /** Set pending persona switch — next buildEffectiveMessage() will prefix the user message */
  setPendingPersonaSwitch(specialistId: string | null): void {
    this.pendingPersonaSwitch = { specialistId }
  }

  /**
   * Arm (or clear) the one-shot specialist-ready signal. When armed with a
   * non-null name, the next buildEffectiveMessage() prepends the sentinel line
   * `[PROJECT SPECIALIST READY: <name>]` and clears the flag.
   */
  setPendingSpecialistReadySignal(specialistName: string | null): void {
    this.pendingSpecialistReadySignal = specialistName
  }

  /** Set memory context (called during start()) */
  setMemoryContext(ctx: string | undefined): void {
    this.memoryContext = ctx
  }

  /** Reset all state for a new session */
  resetSession(): void {
    this.memoryContext = undefined
    this.promptCache.invalidate()
    this.cachedTone = null
    this.cachedToneConversationId = null
    this.turnCountMap.clear()
    this.pendingModeSwitch = null
    this.pendingPersonaSwitch = null
    this.pendingSpecialistReadySignal = null
    this.pendingContextInjection.clear()
    this.pendingCompaction.clear()
  }

  /** Clear all per-conversation state (turn count, pending injections, compaction). */
  clearConversation(conversationId: string): void {
    this.turnCountMap.delete(conversationId)
    this.pendingContextInjection.delete(conversationId)
    this.pendingCompaction.delete(conversationId)
  }

  // ── Private Helpers ──

  /**
   * Progressive memory budget decay by turn count.
   * Turn 1: full budget (memory is fresh). Decays gradually to avoid steep
   * drop-off. Floor ensures critical user preferences survive long sessions.
   *
   * Index = clamped turnCount. Last value is the floor for all subsequent turns.
   */
  private static readonly MEMORY_BUDGET_TIERS = {
    economy:  [2000, 2000, 1200, 800, 500, 300] as const,
    standard: [3000, 3000, 2000, 1500, 1000, 700, 500] as const
  } as const

  private getMemoryBudgetForTurn(turnCount: number, costPreference: CostPreference): number {
    const tiers = costPreference === 'economy'
      ? DaVinciPromptAssembler.MEMORY_BUDGET_TIERS.economy
      : DaVinciPromptAssembler.MEMORY_BUDGET_TIERS.standard
    const idx = Math.min(turnCount, tiers.length - 1)
    return tiers[idx]
  }

  /**
   * Extract only the "Feedback & Corrections" section from memory context.
   * Used on turns 3+ to avoid re-injecting the full memory block that's already in history.
   */
  private extractFeedbackMemories(memoryContext: string): string | null {
    // Look for a Feedback & Corrections section header (### or ##).
    // Handle literal &, &amp;, and &#38; in case the memory service encodes HTML entities.
    const feedbackMatch = memoryContext.match(
      /#{2,3}\s*Feedback\s*(?:&|&amp;|&#38;)\s*Corrections\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/i
    )
    if (feedbackMatch?.[1]?.trim()) {
      return feedbackMatch[1].trim()
    }
    return null
  }
}
