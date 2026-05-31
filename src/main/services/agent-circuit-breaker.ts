import type { StreamChunk } from './agent-base.service'
import type { ContextWindowTier } from './context-management'
import { chatAgentLogger } from '../logger'
import { eventLoggerService } from './event-logger.service'

/** Tool call limits — plan mode needs room for file reads + searches */
const MAX_PLAN_TOOL_CALLS = 50
const MAX_BUILD_TOOL_CALLS = 80

/**
 * S1: Tier-aware plan-mode limits for local LLMs.
 * Plan mode needs generous tool budgets — models frequently explore 3-5 files
 * via Read + 2-3 Grep searches before producing a plan. With parallel tool calls
 * a single turn can consume 2-3 tool uses, so the limit must be well above maxTurns.
 * Formula: maxTurns × 2.5, rounded up.
 */
const LOCAL_PLAN_LIMITS: Record<ContextWindowTier, number> = {
  small: 30, // 12 maxTurns × 2.5 — allows ~2.5 tools/turn average
  medium: 38, // 15 maxTurns × 2.5
  large: 50 // 30 maxTurns, capped at Claude-level MAX_PLAN_TOOL_CALLS
}
const LOCAL_BUILD_LIMITS: Record<ContextWindowTier, number> = {
  small: 30, // 15 maxTurns × 2
  medium: 50, // 25 maxTurns × 2
  large: 80 // 50 maxTurns, same as Claude MAX_BUILD_TOOL_CALLS
}

/**
 * Result of evaluating a tool use against the circuit breaker.
 * When `broken` is true, the caller should stop the stream.
 * When `errorChunk` is provided, emit it before stopping.
 */
export interface CircuitBreakerResult {
  /** Whether the circuit was just broken (caller should stop) */
  broken: boolean
  /** Error chunk to emit to the renderer, if the hard limit was hit */
  errorChunk?: StreamChunk
  /** Whether the stream should terminate after current tool completes (soft stop) */
  shouldTerminate: boolean
  /** S1: Optional additional context to inject into the conversation (e.g. early warnings) */
  additionalContext?: string
  /**
   * When true, the breaker fired for a local LLM in plan mode.
   * The recovery manager should treat this as a continuable condition
   * (save plan state + auto-continue) rather than a hard error.
   */
  isLocalPlanBreak?: boolean
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
      const isLocalPlan = !!opts.isLocalProvider && !opts.isBuildMode
      this.log.error(
        `Generalist circuit breaker: ${this._toolCallCount} tool calls exceeded ${opts.isBuildMode ? 'build' : 'plan'} limit of ${toolCallLimit}`
      )
      eventLoggerService.logAgentToolCall({
        agentId: 'da-vinci',
        conversationId: opts.conversationId,
        toolName: '__circuit_breaker__',
        toolCallNumber: this._toolCallCount
      })

      // Local plan mode: don't show a hard error — the recovery manager will
      // save plan state and auto-continue from where we left off.
      if (isLocalPlan) {
        return {
          broken: true,
          shouldTerminate: true,
          isLocalPlanBreak: true
          // No errorChunk — recovery manager handles the UX
        }
      }

      const errorMessage = opts.isBuildMode
        ? `I made ${this._toolCallCount} tool calls, which suggests I got stuck. Try breaking your request into smaller steps (e.g., "run npm install" then "run npm start").`
        : `I made ${this._toolCallCount} tool calls trying to help, which is more than expected for plan mode. If you need me to run commands, switch to **Build mode** using the toggle in the chat header.`
      return {
        broken: true,
        shouldTerminate: true,
        errorChunk: {
          type: 'error',
          error: errorMessage
        }
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
