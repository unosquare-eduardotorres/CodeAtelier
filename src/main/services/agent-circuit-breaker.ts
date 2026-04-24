import type { StreamChunk } from './agent-base.service'
import { chatAgentLogger } from '../logger'
import { eventLoggerService } from './event-logger.service'

/** Tool call limits — plan mode needs room for file reads + searches */
const MAX_PLAN_TOOL_CALLS = 50
const MAX_BUILD_TOOL_CALLS = 80

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
}

/**
 * Extracts tool call limiting and gratuitous tool detection from ChatAgentService.
 *
 * Responsibilities:
 * - Track tool call count per interaction
 * - Detect gratuitous tool use (first tool after 500+ chars of text)
 * - Soft warning at 5/8 tool calls in build mode
 * - Hard circuit break at MAX_PLAN/BUILD_TOOL_CALLS
 * - Generate error messages for circuit break
 */
export class AgentCircuitBreaker {
  private readonly log = chatAgentLogger
  private _toolCallCount = 0
  private _circuitBroken = false

  /**
   * Evaluate a tool use event against the circuit breaker policy.
   * Returns whether the circuit was broken and any error chunk to emit.
   */
  onToolUse(opts: {
    isBuildMode: boolean
    accumulatedTextLength: number
    conversationId: string
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

    const toolCallLimit = opts.isBuildMode ? MAX_BUILD_TOOL_CALLS : MAX_PLAN_TOOL_CALLS
    if (this._toolCallCount >= toolCallLimit) {
      this._circuitBroken = true
      this.log.error(
        `Generalist circuit breaker: ${this._toolCallCount} tool calls exceeded ${opts.isBuildMode ? 'build' : 'plan'} limit of ${toolCallLimit}`
      )
      eventLoggerService.logAgentToolCall({
        agentId: 'generalist',
        conversationId: opts.conversationId,
        toolName: '__circuit_breaker__',
        toolCallNumber: this._toolCallCount
      })
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

  /** Log a tool call to event log (for non-control tools) */
  logToolCall(conversationId: string, toolName: string): void {
    eventLoggerService.logAgentToolCall({
      agentId: 'generalist',
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
  }
}
