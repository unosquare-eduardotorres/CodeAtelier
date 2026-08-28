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
const MAX_PLAN_TOOL_CALLS = 250
const MAX_BUILD_TOOL_CALLS = 400

/**
 * S1: Tier-aware limits for local LLMs.
 * Raised proportionally from the old values to serve as runaway guards.
 * With auto-continue (up to 3×), effective ceilings are 3× these values.
 */
const LOCAL_PLAN_LIMITS: Record<ContextWindowTier, number> = {
  small: 50, // was 30
  medium: 75, // was 38
  large: 100 // was 50 — local caps track context-window degradation, not Claude policy
}
const LOCAL_BUILD_LIMITS: Record<ContextWindowTier, number> = {
  small: 60, // was 30
  medium: 100, // was 50
  large: 150 // was 80 — local caps track context-window degradation, not Claude policy
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
 * - S1: Tier-aware limits for local LLMs
 * - Soft warning at 5/8 tool calls in build mode
 * - Hard circuit break at MAX_PLAN/BUILD_TOOL_CALLS
 * - Generate error messages for circuit break
 */
export class AgentCircuitBreaker {
  private readonly log = chatAgentLogger
  private _toolCallCount = 0
  private _circuitBroken = false
  private _budgetLogged = false

  /**
   * Evaluate a tool use event against the circuit breaker policy.
   * Returns whether the circuit was broken and any error chunk to emit.
   *
   * S1: When `isLocalProvider` and `contextTier` are provided, uses tier-aware
   * limits instead of the flat MAX_PLAN/BUILD_TOOL_CALLS.
   */
  onToolUse(opts: {
    isBuildMode: boolean
    accumulatedTextLength: number
    conversationId: string
    /** S1: Whether this is a local LLM provider (enables tier-aware limits) */
    isLocalProvider?: boolean
    /** S1: Context window tier — drives the tool call limit for local LLMs */
    contextTier?: ContextWindowTier
    /** CB-GOAL-01: A goal condition is active for this stream. */
    hasGoalCondition?: boolean
  }): CircuitBreakerResult {
    this._toolCallCount++

    // Gratuitous tool detection — if model already wrote a substantial answer
    // (500+ chars) and is now making its FIRST tool call, it's a post-answer
    // verification pattern. Soft-stop via circuit breaker to prevent further turns.
    //
    // NOTE on the actual mechanism: the returned `shouldTerminate` is not consumed
    // anywhere in production (handleToolUseChunk branches only on `broken`). What
    // really stops the stream is `_circuitBroken = true` here, which the executor
    // loop checks (`if (this.circuitBreaker.isBroken) break` in agent-session.service)
    // on the NEXT chunk — so it stops *before* this tool's result is processed, not
    // "after this tool". Callers must pass a TURN-scoped length: on an auto-continuation
    // the per-message accumulator still holds the pre-break turn's text, which would
    // trip this on the continuation's very first tool call and kill it immediately.
    //
    // PLAN MODE ONLY. The premise — "the model already answered, so this first tool
    // call is redundant post-answer verification" — only holds when answering IS the
    // deliverable. In build mode "write a paragraph, then act" is the normal rhythm,
    // and the heuristic reads a status recap as a finished answer, cutting the stream
    // mid-tool and orphaning real work.
    //
    // CB-GOAL-01: The same premise fails for goal-conditioned plan sessions
    // (blueprint phases, chat /goal): the deliverable is a structured artifact
    // (questions block, plan JSON, …), and the model legitimately gathers
    // context with tools BEFORE producing it. Observed live: GLM streamed
    // 1850 chars of clarify analysis, called `read` to pull the portal context
    // doc, and this heuristic killed the turn — no questions block ever formed.
    if (
      !opts.isBuildMode &&
      !opts.hasGoalCondition &&
      this._toolCallCount === 1 &&
      opts.accumulatedTextLength >= 500
    ) {
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

    // Budget breadcrumb at 80% of the limit. This used to emit an
    // `additionalContext` nudge addressed to the model — but that string was only
    // ever rendered to the human as a blockquote and never entered the model's
    // context. Log-only keeps the diagnostic without the fake nudge.
    if (!this._budgetLogged && this._toolCallCount >= Math.floor(toolCallLimit * 0.8)) {
      this._budgetLogged = true
      this.log.info(
        `[PIPELINE:tool-budget-80pct] conversationId=${opts.conversationId} ` +
          `count=${this._toolCallCount}/${toolCallLimit} — continuable break at limit`
      )
    }

    if (this._toolCallCount >= toolCallLimit) {
      this._circuitBroken = true
      this.log.warn(
        `[PIPELINE:circuit-breaker] ${this._toolCallCount} tool calls reached ` +
          `${opts.isBuildMode ? 'build' : 'plan'} limit of ${toolCallLimit} — ` +
          `continuable break (recovery manager will auto-continue)`
      )
      eventLoggerService.logAgentToolCall({
        agentId: 'specialist',
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
      agentId: 'specialist',
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
    this._budgetLogged = false
  }
}
