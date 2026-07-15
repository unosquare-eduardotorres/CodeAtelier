import type { ContextWindowTier } from './context-management'
import { chatAgentLogger } from '../logger'
import { eventLoggerService } from './event-logger.service'

/**
 * Tool call limits — runaway-loop guards, NOT productivity walls.
 *
 * These are intentionally high ceilings (2–3× the old values). A legitimate
 * long task that reaches them will auto-continue via the recovery manager
 * (up to MAX_TURN_CONTINUATIONS), then show a "Continue" button.
 * Only a pathological loop should hit these limits meaningfully.
 *
 * Reference: Neither Claude Code nor OpenCode impose tool-call caps;
 * they rely on auto-compaction + cost ceilings. Our budget guard
 * (AgentExecutorFactory.checkPreFlightBudget → BudgetExceededError)
 * is the real spend ceiling.
 */
const MAX_PLAN_TOOL_CALLS = 100
const MAX_BUILD_TOOL_CALLS = 150

/**
 * S1: Tier-aware limits for local LLMs.
 * Raised proportionally from the old values to serve as runaway guards.
 * With auto-continue (up to 3×), effective ceilings are 3× these values.
 */
const LOCAL_PLAN_LIMITS: Record<ContextWindowTier, number> = {
  small: 50, // was 30
  medium: 75, // was 38
  large: 100 // was 50, now matches Claude MAX_PLAN_TOOL_CALLS
}
const LOCAL_BUILD_LIMITS: Record<ContextWindowTier, number> = {
  small: 60, // was 30
  medium: 100, // was 50
  large: 150 // was 80, now matches Claude MAX_BUILD_TOOL_CALLS
}

/**
 * Result of evaluating a tool use against the circuit breaker.
 * When `broken` is true, the caller should stop the stream.
 */
export interface CircuitBreakerResult {
  /** Whether the circuit was just broken (caller should stop) */
  broken: boolean
  /** Whether the stream should terminate after current tool completes (soft stop) */
  shouldTerminate: boolean
  /** S1: Optional additional context to inject into the conversation (e.g. early warnings) */
  additionalContext?: string
  /**
   * When true, the breaker fired as a continuable condition.
   * The recovery manager should treat this as a max_turns event
   * (save plan state + auto-continue) rather than a hard error.
   * This is the default for all breaker trips — both Claude and local,
   * both plan and build mode.
   */
  isContinuableBreak?: boolean
}

/**
 * Extracts tool call limiting and gratuitous tool detection from ChatAgentService.
 *
 * Responsibilities:
 * - Track tool call count per interaction
 * - Detect gratuitous tool use (first tool after 500+ chars of text)
 * - S1: Tier-aware limits for local LLMs with 60% early warning
 * - Soft warning at 5/8 tool calls in build mode
 * - Hard circuit break at MAX_PLAN/BUILD_TOOL_CALLS
 * - Generate error messages for circuit break
 */
export class AgentCircuitBreaker {
  private readonly log = chatAgentLogger
  private _toolCallCount = 0
  private _circuitBroken = false
  private _earlyWarningEmitted = false

  /**
   * Evaluate a tool use event against the circuit breaker policy.
   * Returns whether the circuit was broken and any error chunk to emit.
   *
   * S1: When `isLocalProvider` and `contextTier` are provided, uses tier-aware
   * limits instead of the flat MAX_PLAN/BUILD_TOOL_CALLS. Emits a 60% early
   * warning nudge to steer the model toward writing its plan/summary.
   */
  onToolUse(opts: {
    isBuildMode: boolean
    accumulatedTextLength: number
    conversationId: string
    /** S1: Whether this is a local LLM provider (enables tier-aware limits) */
    isLocalProvider?: boolean
    /** S1: Context window tier — drives the tool call limit for local LLMs */
    contextTier?: ContextWindowTier
  }): CircuitBreakerResult {
    this._toolCallCount++

    // Gratuitous tool detection — if model already wrote a substantial answer
    // (500+ chars) and is now making its FIRST tool call, it's a post-answer
    // verification pattern. Soft-stop via circuit breaker to prevent further turns.
    if (this._toolCallCount === 1 && opts.accumulatedTextLength >= 500) {
      this.log.warn(
        `[PIPELINE:gratuitous-tool-soft-stop] conversationId=${opts.conversationId} textLen=${opts.accumulatedTextLength} — already answered, stopping after this tool`
      )
      this._circuitBroken = true
      return { broken: false, shouldTerminate: true }
    }

    // Soft warning at 5 tool calls — approaching prompt-stated target
    if (this._toolCallCount === 5 && opts.isBuildMode) {
      this.log.warn(
        `[PIPELINE:tool-limit-warning] conversationId=${opts.conversationId} — 5 tool calls reached, approaching limit`
      )
    }
    // Hard limit warning at 8 — prompt-stated HARD LIMIT exceeded
    if (this._toolCallCount === 8 && opts.isBuildMode) {
      this.log.warn(
        `[PIPELINE:tool-limit-reached] conversationId=${opts.conversationId} — 8 tool calls, prompt hard limit exceeded`
      )
    }

    // S1: Resolve tier-aware limit for local LLMs
    const toolCallLimit = this.resolveToolCallLimit(
      opts.isBuildMode,
      opts.isLocalProvider,
      opts.contextTier
    )

    // S1: 60% early warning for local LLMs — nudge the model to start writing
    // C4: 80% early warning for Claude build mode — prevent hard circuit break
    if (!this._earlyWarningEmitted) {
      const isLocal = !!opts.isLocalProvider
      const earlyWarningPct = isLocal ? 0.6 : 0.8
      const shouldNudge = isLocal || (!isLocal && opts.isBuildMode)

      if (shouldNudge) {
        const earlyWarningThreshold = Math.floor(toolCallLimit * earlyWarningPct)
        if (this._toolCallCount >= earlyWarningThreshold) {
          this._earlyWarningEmitted = true
          this.log.info(
            `[PIPELINE:early-warning] conversationId=${opts.conversationId} ` +
              `provider=${isLocal ? 'local' : 'claude'} ` +
              `count=${this._toolCallCount}/${toolCallLimit} (${Math.round(earlyWarningPct * 100)}% threshold=${earlyWarningThreshold})`
          )
          return {
            broken: false,
            shouldTerminate: false,
            additionalContext: isLocal
              ? `You've used ${this._toolCallCount}/${toolCallLimit} tool calls. ` +
                `Start writing your plan/summary now. ` +
                `Use remaining calls only if absolutely essential.`
              : `You've used ${this._toolCallCount}/${toolCallLimit} tool calls. ` +
                `Start wrapping up your current task. ` +
                `Complete what you're doing and summarize any remaining work.`
          }
        }
      }
    }

    if (this._toolCallCount >= toolCallLimit) {
      this._circuitBroken = true
      this.log.warn(
        `[PIPELINE:circuit-breaker] ${this._toolCallCount} tool calls reached ` +
          `${opts.isBuildMode ? 'build' : 'plan'} limit of ${toolCallLimit} — ` +
          `continuable break (recovery manager will auto-continue)`
      )
      eventLoggerService.logAgentToolCall({
        agentId: 'da-vinci',
        conversationId: opts.conversationId,
        toolName: '__circuit_breaker__',
        toolCallNumber: this._toolCallCount
      })

      // All breaker trips are continuable — the recovery manager will
      // save progress and auto-continue (up to MAX_TURN_CONTINUATIONS),
      // then show a "Continue" button when exhausted. No hard error.
      return {
        broken: true,
        shouldTerminate: true,
        isContinuableBreak: true
      }
    }

    return { broken: false, shouldTerminate: false }
  }

  /**
   * S1: Resolve the tool call limit based on provider and tier.
   * Local LLMs get tier-aware limits; Claude gets flat limits.
   */
  private resolveToolCallLimit(
    isBuildMode: boolean,
    isLocal?: boolean,
    tier?: ContextWindowTier
  ): number {
    if (isLocal && tier) {
      return isBuildMode ? LOCAL_BUILD_LIMITS[tier] : LOCAL_PLAN_LIMITS[tier]
    }
    return isBuildMode ? MAX_BUILD_TOOL_CALLS : MAX_PLAN_TOOL_CALLS
  }

  /** Log a tool call to event log (for non-control tools) */
  logToolCall(conversationId: string, toolName: string): void {
    eventLoggerService.logAgentToolCall({
      agentId: 'da-vinci',
      conversationId,
      toolName,
      toolCallNumber: this._toolCallCount
    })
  }

  get isBroken(): boolean {
    return this._circuitBroken
  }

  get count(): number {
    return this._toolCallCount
  }

  /** Reset state for a new interaction */
  reset(): void {
    this._toolCallCount = 0
    this._circuitBroken = false
    this._earlyWarningEmitted = false
  }
}
