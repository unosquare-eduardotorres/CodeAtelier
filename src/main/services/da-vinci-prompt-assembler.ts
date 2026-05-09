import type { ConversationMode, CostPreference, Specialist } from '../../shared/types'
import { chatAgentLogger } from '../logger'
import { PromptBuilder, promptBuilder } from './prompt-builder'
import { memoryService } from './memory.service'
import { specialistRepository } from '../db/repositories'
import {
  appendMcpToolGuidance,
  buildConditionalPrefix,
  type PromptFeatureFlags
} from './prompt-assembly-helpers'

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
}

/** Options for building the effective user message */
export interface BuildEffectiveMessageOptions {
  message: string
  conversationId: string
  hasImages: boolean
  turnCount: number
  sessionId: string | undefined
  mode: ConversationMode
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
    // Local LLM: condensed prompt — skip memory/skills/caching strategies
    if (opts.isLocalProvider) {
      return promptBuilder.buildLocalPrompt({
        role: 'da-vinci',
        mode: opts.mode,
        workspacePath: opts.workspacePath,
        budgetTier: 'minimal'
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
        personaSkillOverrides: undefined
      })

      // Strategy δ: MCP tool guidance sections on turn 1 only.
      promptWithMcpGuidance = appendMcpToolGuidance(basePrompt, opts.turnCount, opts.featureFlags)

      // Cache the snapshot for reuse on subsequent turns
      this.systemPromptSnapshot = promptWithMcpGuidance
      this.systemPromptSnapshotMode = opts.mode
      this.systemPromptSnapshotConversationId = opts.conversationId
    }

    // Diagnostic: hash the system prompt to verify cache prefix stability across turns.
    // If the hash differs between turns, the system prompt changed and prompt caching
    // will miss — explaining 0% cache hit rates.
    const promptHash = Buffer.from(promptWithMcpGuidance).toString('base64').slice(0, 12)
    this.log.info(
      `[PIPELINE:prompt-hash] turn=${opts.turnCount} hash=${promptHash} reused=${!!canReuseSnapshot}`
    )

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
      turnCount: opts.turnCount
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
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null
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
    this.systemPromptSnapshot = null
    this.systemPromptSnapshotMode = null
    this.systemPromptSnapshotConversationId = null
    this.turnCountMap.clear()
    this.pendingModeSwitch = null
    this.pendingPersonaSwitch = null
    this.pendingSpecialistReadySignal = null
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
   *
   * Cache-audit optimization: balanced turn-1 budget reduced from 5000→3000 chars
   * (~600 fewer tokens on the first turn). Economy budget reduced from 3000→2000.
   * This shrinks the dynamic user-message payload while still providing ample context.
   */
  private getMemoryBudgetForTurn(turnCount: number, costPreference: CostPreference): number {
    // Strategy 9: Memory budget floor — retain 300-500 chars for critical user preferences
    // even in long conversations (turn 4+). Previously dropped to 0, causing the model
    // to forget user preferences and corrections in extended sessions.
    if (costPreference === 'economy') {
      return turnCount <= 1 ? 2000 : turnCount <= 3 ? 800 : 300
    }
    return turnCount <= 1 ? 3000 : turnCount <= 3 ? 1500 : 500
  }

  /**
   * Extract only the "Feedback & Corrections" section from memory context.
   * Used on turns 3+ to avoid re-injecting the full memory block that's already in history.
   */
  private extractFeedbackMemories(memoryContext: string): string | null {
    // Look for a Feedback & Corrections section header (### or ##)
    const feedbackMatch = memoryContext.match(
      /#{2,3}\s*Feedback\s*[&]\s*Corrections\s*\n([\s\S]*?)(?=\n#{2,3}\s|\n---|$)/i
    )
    if (feedbackMatch?.[1]?.trim()) {
      return feedbackMatch[1].trim()
    }
    return null
  }
}
