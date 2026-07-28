/**
 * AgentRecoveryManager — handles session recovery, stream finalization,
 * error handling, plan state persistence, and structured summary extraction.
 *
 * Extracted from AgentSessionService to reduce god-class complexity.
 * Holds a back-reference to the session for state access.
 *
 * @internal Not for use outside the agent-session module.
 */

import type { AgentSessionHost, StreamLoopState, StreamChunk } from './agent-session-host'
import { SESSION_CONSTANTS } from './agent-session-host'
import type { AgentIntent, LLMProvider } from '../../shared/types'
import type { AdapterMcpResult } from './agent-session.types'
import { resolveModelAction } from '../../shared/constants'
import { resolveModelFromSnapshot } from './snapshot-model-resolver'
import { conversationRepository } from '../db/repositories'
import { localPlanStateService } from './local-plan-state.service'
import type { DiscoveredContext } from './local-plan-state.service'

// N8: Single source of truth for the turn-limit-exhausted message (text fallback)
const TURN_LIMIT_EXHAUSTED_MSG =
  '\n\n---\n\n' +
  "⏱️ **Turn limit reached** — I've used all available turns for this interaction. " +
  'The session is preserved and you can send another message to continue where I left off.\n\n' +
  '_Send "continue" or describe what you\'d like me to do next._'

export class AgentRecoveryManager {
  private readonly s: AgentSessionHost

  constructor(session: unknown) {
    this.s = session as AgentSessionHost
  }

  // ── N7: Shared auto-continue logic ──────────────────────────────────────

  /**
   * Build a continuation prompt and execute a new stream turn.
   * Used by both finalizeStream (happy path) and handleStreamError (error path)
   * when max_turns is reached and continuations remain.
   */
  private async continueTurnLimit(params: {
    conversationId: string
    systemPrompt: string
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
    recoveryDepth: number
  }): Promise<void> {
    const { conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider, recoveryDepth } =
      params

    this.s.maxTurnsContinuations++
    this.s.circuitBreaker.reset()
    this.s.log.info(
      `[PIPELINE:max-turns-continue] continuation=${this.s.maxTurnsContinuations}/${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS} ` +
        `conversationId=${conversationId}`
    )

    this.s.emit('chunk', {
      type: 'text',
      content: `\n\n_Continuing... (turn limit reached, auto-resuming ${this.s.maxTurnsContinuations}/${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS})_\n\n`
    } as StreamChunk)

    const isLocal = llmProvider === 'local-llm'
    let continuationPrompt: string

    if (isLocal) {
      const discoveries = this.s.toolActivityAccumulator.buildDiscoverySummary(2000)
      const planState = localPlanStateService.getForConversation(conversationId)
      const partialPlan = this.s.accumulatedText.slice(-1000)

      continuationPrompt = [
        '## Continuation — Complete the Plan',
        '',
        '### Original Request',
        planState?.originalRequest ??
          (typeof this.s.lastStreamOpts?.sdkPrompt === 'string'
            ? (this.s.lastStreamOpts.sdkPrompt as string).slice(0, 500)
            : ''),
        '',
        '### What You Found',
        discoveries || '(no tool results recorded)',
        '',
        '### Partial Plan',
        partialPlan || '(none yet)',
        '',
        '### Instructions',
        'Complete the plan NOW. Do NOT re-read files you already explored.',
        'Write the remaining plan items. Use at most 2 more tool calls if essential.'
      ].join('\n')
    } else {
      continuationPrompt = isBuildMode
        ? 'Continue implementing from where you left off. Do not repeat completed work.'
        : 'Continue your analysis from where you left off. Do not repeat completed work.'
    }

    // AUTOCONT-TURN-DUP-01: Increment turn counter before continuation to avoid
    // duplicate turn_usage rows. Without this, the same turn_number is reused,
    // causing inflated token counts and impossible cache hit rates (>100%).
    const nextTurnCount = (this.s.turnCounts.get(conversationId) ?? 0) + 1
    this.s.turnCounts.set(conversationId, nextTurnCount)

    await this.s.executeStream({
      sdkPrompt: continuationPrompt,
      systemPrompt,
      sessionId: isLocal ? undefined : this.s.sessionMap.get(conversationId),
      conversationId,
      turnCount: nextTurnCount,
      isBuildMode,
      mcpResult,
      llmProvider,
      recoveryDepth // Preserve depth so recovery can't restart on continuations
    })
  }

  // ── handleSessionRecovery ─────────────────────────────────────────────

  async handleSessionRecovery(params: {
    sessionRecoveryNeeded: boolean
    recoveryDepth: number
    maxRecoveryDepth: number
    sdkPrompt: string | AsyncIterable<unknown>
    systemPrompt: string
    conversationId: string
    turnCount: number
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
  }): Promise<'continue' | 'returned'> {
    if (!params.sessionRecoveryNeeded) return 'continue'

    if (params.recoveryDepth >= params.maxRecoveryDepth) {
      this.s.log.error('[PIPELINE:session-recovery-depth-exceeded] Max recovery depth reached')
      this.s.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'failed',
        content: 'Session recovery failed (max retries). Please start a new conversation.'
      } as StreamChunk)
      this.s.currentStatus = 'failed'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return 'returned'
    }

    try {
      // Enrich recovery prompt with saved summary
      let recoveryPrompt = params.sdkPrompt
      if (typeof recoveryPrompt === 'string') {
        try {
          const summary = conversationRepository.getSummary(params.conversationId)
          if (summary) {
            recoveryPrompt = `## Session Recovery Context\n${summary}\n\n## Original Request\n${recoveryPrompt}`
            this.s.log.info(
              `[C3:recovery-summary-injected] conversationId=${params.conversationId} summaryLen=${summary.length}`
            )
          }
        } catch {
          /* non-fatal — proceed with original prompt */
        }
      }

      await this.s.executeStream({
        sdkPrompt: recoveryPrompt,
        systemPrompt: params.systemPrompt,
        sessionId: undefined,
        conversationId: params.conversationId,
        turnCount: params.turnCount,
        isBuildMode: params.isBuildMode,
        mcpResult: params.mcpResult,
        llmProvider: params.llmProvider,
        recoveryDepth: params.recoveryDepth + 1
      })
      return 'returned'
    } catch (retryError) {
      this.s.log.error('[PIPELINE:session-recovery-failed]', retryError)
      this.s.currentStatus = 'failed'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return 'returned'
    }
  }

  // ── finalizeStream sub-methods ──────────────────────────────────────

  /**
   * Handle overload detection and max_turns auto-continue.
   * Returns 'handled' when the method emits complete, 'continue' when
   * finalization should proceed to recovery/summary.
   */
  private async handleOverloadOrMaxTurns(params: {
    streamState: StreamLoopState
    conversationId: string
    systemPrompt: string
    isBuildMode: boolean
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
    recoveryDepth: number
  }): Promise<'handled' | 'continue'> {
    const { streamState, conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider, recoveryDepth } = params

    // Skip if the underlying cause was API overload
    if (streamState.overloadDetected && streamState.lastTerminalReason === 'max_turns') {
      this.s.log.warn(
        `[PIPELINE:overload-skip-continue] Skipping auto-continue — API overload detected for conversationId=${conversationId}`
      )
      this.s.emit('chunk', {
        type: 'text',
        content:
          '\n\n---\n\n' +
          '⚠️ **Claude is temporarily overloaded** — the API returned 529 errors during this session. ' +
          'This is a server-side issue and not a problem with your request.\n\n' +
          'Try again in a few minutes. If it persists, check [status.claude.com](https://status.claude.com).'
      } as StreamChunk)
      this.s.currentStatus = 'idle'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return 'handled'
    }

    if (
      streamState.lastTerminalReason === 'max_turns' &&
      this.s.maxTurnsContinuations < SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      await this.continueTurnLimit({
        conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider, recoveryDepth
      })
      return 'handled'
    }

    // All auto-continuations exhausted — emit a structured turn_limit chunk
    // so the renderer can show a one-click Continue button.
    if (
      streamState.lastTerminalReason === 'max_turns' &&
      this.s.maxTurnsContinuations >= SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      this.s.log.info(
        `[PIPELINE:max-turns-exhausted] All ${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS} ` +
          `continuations used — emitting turn_limit chunk for conversationId=${conversationId}`
      )
      // Emit structured chunk for the renderer's Continue button
      this.s.emit('chunk', {
        type: 'turn_limit',
        content: TURN_LIMIT_EXHAUSTED_MSG,
        turnLimit: {
          continuable: true,
          continuationsUsed: this.s.maxTurnsContinuations,
          continuationsMax: SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
        }
      } as StreamChunk)
    }

    return 'continue'
  }

  /**
   * Plan-mode tool-block recovery + nudge attempt.
   */
  private async attemptStreamRecovery(params: {
    streamState: StreamLoopState
    conversationId: string
    systemPrompt: string
    isBuildMode: boolean
    timedOut: boolean
  }): Promise<void> {
    const { streamState, conversationId, systemPrompt, isBuildMode, timedOut } = params

    // Plan-mode tool-block recovery: fire a deterministic emit_plan recovery
    // so the user still gets a plan card.  Gated by adapter capability so
    // blueprint / grill / audit / council sessions (which also run in plan
    // mode) are never hijacked by a pointless recovery turn.
    // Also skipped for local-LLM — there is no emit_plan-via-Claude path for local.
    let planRecoveryAttempted = false
    if (
      this.s.adapter.supportsEmitPlanRecovery &&
      streamState.planModeToolBlock &&
      this.s.currentMode === 'plan' &&
      !this.s.controlToolState.plan &&
      !timedOut &&
      this.s.llmProvider !== 'local-llm'
    ) {
      try {
        const result = await this.s.recoveryNudge.attemptPlanToolRecovery({
          cliExecutor: this.s.cliExecutor,
          systemPrompt,
          workspacePath: this.s.workspacePath!,
          model: resolveModelFromSnapshot(
            conversationId,
            this.s.workspacePath!,
            resolveModelAction(this.s.adapter.role, false),
            false
          ),
          sessionId: this.s.sessionMap.get(conversationId),
          conversationId,
          workspaceId: this.s.workspaceId,
          mcpConfigPath: this.s.getCliMcpConfigPath(),
          onSessionCapture: (sid) => this.s.sessionMap.set(conversationId, sid),
          onChunk: (chunk) => this.s.emit('chunk', chunk),
          onTokens: (tokens) => {
            this.s.tokenUsage += tokens
          }
        })
        planRecoveryAttempted = result.attempted
      } catch (err) {
        this.s.log.warn('[PIPELINE:plan-recovery-failed] Non-critical:', err)
      }
    } else if (
      this.s.adapter.supportsEmitPlanRecovery &&
      streamState.planModeToolBlock &&
      this.s.llmProvider === 'local-llm'
    ) {
      this.s.log.info('[PIPELINE:plan-tool-recovery-skipped] local provider')
    }

    // Nudge: attempt recovery if tool calls occurred without trailing text
    const skipNudgeReasons = new Set([
      'max_turns',
      'hook_stopped',
      'aborted_tools',
      'aborted_streaming'
    ])
    const shouldSkipNudge =
      (streamState.lastTerminalReason && skipNudgeReasons.has(streamState.lastTerminalReason)) ||
      planRecoveryAttempted
    if (
      this.s.circuitBreaker.count > 0 &&
      !streamState.hasTextAfterLastTool &&
      !shouldSkipNudge &&
      !timedOut
    ) {
      this.s.log.warn(
        `[PIPELINE:recovery-nudge-triggered] conversationId=${conversationId} ` +
          `toolCalls=${this.s.circuitBreaker.count} accumulatedTextLen=${this.s.accumulatedText.length}`
      )
      const recoveryResult = await this.s.recoveryNudge.attemptRecovery({
        cliExecutor: this.s.cliExecutor,
        systemPrompt,
        workspacePath: this.s.workspacePath!,
        model: resolveModelFromSnapshot(
          conversationId,
          this.s.workspacePath!,
          resolveModelAction(this.s.adapter.role, isBuildMode),
          isBuildMode
        ),
        isBuildMode,
        skipCliTurn: this.s.llmProvider === 'local-llm',
        sessionId: this.s.sessionMap.get(conversationId),
        conversationId,
        workspaceId: this.s.workspaceId,
        toolCallCount: this.s.circuitBreaker.count,
        onSessionCapture: (sid) => this.s.sessionMap.set(conversationId, sid),
        onChunk: (chunk) => this.s.emit('chunk', chunk),
        onTokens: (tokens) => {
          this.s.tokenUsage += tokens
        }
      })
      this.s.log.info(
        `[PIPELINE:recovery-nudge-result] recovered=${recoveryResult.recovered} textLen=${recoveryResult.text.length}`
      )
      this.s.accumulatedText += recoveryResult.text
    }
  }

  /**
   * Capture summary, detect intents, mark plan completed, emit baseline response.
   */
  private captureSummaryAndIntents(
    conversationId: string,
    llmProvider: LLMProvider,
    recoveryDepth: number
  ): void {
    // Auto-capture conversation summary for ALL providers
    if (this.s.accumulatedText.length > 100) {
      try {
        const summary = this.extractStructuredSummary(conversationId)
        if (summary) {
          conversationRepository.updateSummary(conversationId, summary)
          this.s.log.info(
            `[S6:summary-captured] conversationId=${conversationId} provider=${llmProvider} len=${summary.length}`
          )
        }
      } catch (err) {
        this.s.log.warn('[S6:summary-capture-failed]', err)
      }

      // Save plan state for cross-session continuity (all providers).
      // saveCurrentPlanState returns early when mode !== 'plan' or no workspaceId.
      this.saveCurrentPlanState(conversationId)
    }

    // Delegate intent detection to the adapter
    this.s.adapter.emitDetectedIntents({
      accumulatedText: this.s.accumulatedText,
      controlToolState: this.s.controlToolState,
      mode: this.s.currentMode,
      conversationId,
      emit: (evt: string, payload: unknown) => this.s.emitAdapterEvent(evt, payload)
    })

    // Mark plan state as completed when a plan intent was detected
    if (this.s.controlToolState.plan) {
      try {
        localPlanStateService.markCompleted(conversationId)
        this.s.log.info(`[F6:plan-completed] conversationId=${conversationId}`)
      } catch (err) {
        this.s.log.warn('[F6:plan-complete-failed]', err)
      }
    }

    // Baseline "response" intent if adapter emitted nothing interesting
    if (!this.s.controlToolState.plan && !this.s.controlToolState.askUser) {
      this.s.emit('intent', {
        type: 'response',
        content: this.s.accumulatedText
      } as AgentIntent)
    }

    this.s.currentStatus = 'idle'
    this.s.flushTokenUsage()
    this.s.emit('statusUpdate', this.s.getStatus())

    if (recoveryDepth > 0) {
      this.s.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'completed',
        content: 'Session recovered successfully.'
      } as StreamChunk)
    }

    this.s.emit('complete')
  }

  // ── finalizeStream ────────────────────────────────────────────────────

  async finalizeStream(params: {
    conversationId: string
    systemPrompt: string
    isBuildMode: boolean
    recoveryDepth: number
    timedOut: boolean
    streamState: StreamLoopState
    mcpResult: AdapterMcpResult
    llmProvider: LLMProvider
  }): Promise<void> {
    const {
      conversationId,
      systemPrompt,
      isBuildMode,
      recoveryDepth,
      timedOut,
      streamState,
      mcpResult,
      llmProvider
    } = params

    if (!streamState.messageStopReceived && !this.s.circuitBreaker.isBroken && !timedOut) {
      this.s.log.warn(
        `[PIPELINE:stream-incomplete] Stream ended without MessageStop event for conversationId=${conversationId}`
      )
    }

    this.s.log.info(
      `[PIPELINE:response-complete] conversationId=${conversationId} textLen=${this.s.accumulatedText.length}`
    )

    // Step 1: Handle overload / max_turns auto-continue
    const overloadResult = await this.handleOverloadOrMaxTurns({
      streamState, conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider, recoveryDepth
    })
    if (overloadResult === 'handled') return

    // Step 2: Plan-mode tool-block recovery + nudge
    await this.attemptStreamRecovery({
      streamState, conversationId, systemPrompt, isBuildMode, timedOut
    })

    // Step 3: Summary capture, intent detection, completion
    this.captureSummaryAndIntents(conversationId, llmProvider, recoveryDepth)
  }

  // ── handleStreamError helpers ──────────────────────────────────────────

  /** Save partial progress on error (all providers). */
  private saveErrorProgress(): void {
    if (
      this.s.accumulatedText.length <= 50 ||
      !this.s.currentConversationId
    ) {
      return
    }
    try {
      const summary = this.extractStructuredSummary(this.s.currentConversationId)
      if (summary) {
        // Guard: don't overwrite a richer prior summary with a sparse error-path one.
        // A brief error turn can produce near-empty output that would clobber
        // detailed context from a prior successful turn.
        const existingSummary = conversationRepository.getSummary(this.s.currentConversationId)
        if (existingSummary && summary.length < existingSummary.length) {
          this.s.log.info(
            `[S6:error-summary-skipped] existing=${existingSummary.length} new=${summary.length} — keeping richer summary`
          )
        } else {
          conversationRepository.updateSummary(this.s.currentConversationId, summary)
          this.s.log.info(
            `[S6:error-summary-saved] conversationId=${this.s.currentConversationId} provider=${this.s.llmProvider} len=${summary.length}`
          )
        }
      }
    } catch {
      /* non-fatal */
    }
    this.saveCurrentPlanState(this.s.currentConversationId)
  }

  /** Classify a stream error into one of the known categories. */
  private classifyStreamError(
    error: Error,
    timedOut: boolean
  ): {
    isOverload: boolean
    isMaxTurns: boolean
    isContextOverflow: boolean
    isAbort: boolean
  } {
    const isAbort = error.name === 'AbortError'
    const isOverload =
      !timedOut &&
      !isAbort &&
      /529|overloaded|server_is_overloaded|503 Service/i.test(error.message)
    const isMaxTurns =
      !timedOut && !isAbort && error.message?.includes('maximum number of turns')
    const isContextOverflow =
      !timedOut &&
      !isAbort &&
      this.s.llmProvider === 'local-llm' &&
      (error.message?.includes('context length') ||
        error.message?.includes('maximum context') ||
        error.message?.includes('too many tokens') ||
        error.message?.includes('exceeds max context') ||
        error.message?.includes('context window') ||
        error.message?.includes('token limit'))
    return { isOverload, isMaxTurns, isContextOverflow, isAbort }
  }

  /** Handle AbortError — either timeout or user cancellation. */
  private handleAbortOrTimeout(
    _error: Error,
    timedOut: boolean,
    effectiveTimeoutMs?: number
  ): void {
    if (timedOut) {
      const actualTimeoutMin = Math.round(
        (effectiveTimeoutMs ?? SESSION_CONSTANTS.MAX_INTERACTION_TIMEOUT_MS) / 60_000
      )
      this.s.log.error('SDK query timed out')
      this.s.emit('chunk', {
        type: 'text',
        content:
          '\n\n---\n\n' +
          `⏱️ **Session timed out** after ${actualTimeoutMin} minutes ` +
          `(${this.s.circuitBreaker.count} tool calls made). ` +
          'This usually means the task is taking longer than expected, not that something is broken.\n\n' +
          'The session is preserved — send another message to continue where I left off, ' +
          'or try breaking the task into smaller steps.'
      } as StreamChunk)
    } else {
      this.s.log.info('SDK query cancelled by user')
    }
  }

  /** Emit idle status + complete for graceful early-return paths. */
  private emitIdleComplete(): void {
    this.s.currentStatus = 'idle'
    this.s.flushTokenUsage()
    this.s.emit('statusUpdate', this.s.getStatus())
    this.s.emit('complete')
  }

  // ── handleStreamError ─────────────────────────────────────────────────

  async handleStreamError(
    error: Error,
    timedOut: boolean,
    recoveryDepth = 0,
    effectiveTimeoutMs?: number
  ): Promise<void> {
    this.s.sdkAbortController = null
    this.saveErrorProgress()

    const { isOverload, isMaxTurns, isContextOverflow, isAbort } =
      this.classifyStreamError(error, timedOut)

    // API overload — don't auto-continue
    if (isOverload) {
      this.s.lastSendOutcome = 'overload'
      this.s.log.warn(`[PIPELINE:overload-error] API overload error: ${error.message}`)
      this.s.emit('chunk', {
        type: 'text',
        content:
          '\n\n---\n\n' +
          '⚠️ **Claude is temporarily overloaded** — the API returned server errors during this session. ' +
          'This is a server-side issue and not a problem with your request.\n\n' +
          'Try again in a few minutes. If it persists, check [status.claude.com](https://status.claude.com).'
      } as StreamChunk)
      this.emitIdleComplete()
      return
    }

    // Auto-continue on max_turns error
    if (
      isMaxTurns &&
      this.s.lastStreamOpts &&
      this.s.maxTurnsContinuations < SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      const { conversationId, systemPrompt, isBuildMode, llmProvider } =
        this.s.lastStreamOpts
      // AUTOCONT-STALE-MCP-01: Rebuild mcpResult from adapter to pick up any
      // MCP config changes made since the stream started. lastStreamOpts captured
      // mcpResult at executeStream() entry — using it directly risks invoking
      // disabled tools or missing newly-enabled ones.
      let freshMcpResult = this.s.lastStreamOpts.mcpResult
      try {
        const controlCallbacks = this.s.adapter.buildControlCallbacks({
          conversationId,
          emit: (evt, payload) => this.s.emitAdapterEvent(evt, payload),
          getAccumulatedText: () => this.s.accumulatedText
        })
        freshMcpResult = this.s.adapter.buildMcpConfig({
          mode: this.s.currentMode,
          workspacePath: this.s.workspacePath!,
          workspaceId: this.s.workspaceId,
          conversationId,
          controlCallbacks,
          contextTier: this.s.lastStreamOpts.contextTier
        })
      } catch {
        // Non-fatal: fall back to stale mcpResult from lastStreamOpts
        this.s.log.warn('[PIPELINE:error-autocont] Failed to rebuild mcpResult — using stale config')
      }
      await this.continueTurnLimit({
        conversationId, systemPrompt, isBuildMode, mcpResult: freshMcpResult, llmProvider, recoveryDepth
      })
      return
    }

    // Max turns — all continuations exhausted
    if (isMaxTurns) {
      this.s.lastSendOutcome = 'turn_limit_exhausted'
      this.s.log.info(
        `[PIPELINE:max-turns-exhausted-error] All ${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS} ` +
          'continuations used (error path) — emitting turn_limit chunk'
      )
      this.s.emit('chunk', {
        type: 'turn_limit',
        content: TURN_LIMIT_EXHAUSTED_MSG,
        turnLimit: {
          continuable: true,
          continuationsUsed: this.s.maxTurnsContinuations,
          continuationsMax: SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
        }
      } as StreamChunk)
      this.emitIdleComplete()
      return
    }

    // Context overflow — graceful handling for local LLMs
    if (isContextOverflow && this.s.currentConversationId) {
      this.s.lastSendOutcome = 'context_overflow'
      this.s.log.warn(
        `[S10:context-overflow] conversationId=${this.s.currentConversationId} — ` +
          `saving progress and emitting recovery message. Error: ${error.message}`
      )
      this.saveCurrentPlanState(this.s.currentConversationId)
      this.s.emit('chunk', {
        type: 'text',
        content:
          '\n\n---\n' +
          '⚠️ **Context limit reached.** Your progress has been saved.\n\n' +
          'Send a follow-up message to continue from where I left off. ' +
          "I'll pick up the plan from the saved context.\n\n" +
          '_Tip: Try breaking complex requests into smaller, focused steps._'
      } as StreamChunk)
      this.emitIdleComplete()
      return
    }

    // Abort / timeout / generic error
    if (isAbort) {
      this.s.lastSendOutcome = 'aborted'
      this.handleAbortOrTimeout(error, timedOut, effectiveTimeoutMs)
    } else {
      this.s.lastSendOutcome = 'error'
      this.s.log.error('SDK send failed:', error)
      this.s.emit('chunk', {
        type: 'error',
        error: `${this.s.adapter.role} SDK error: ${error.message}`
      } as StreamChunk)
    }

    this.s.currentStatus = 'failed'
    this.s.flushTokenUsage()
    this.s.emit('statusUpdate', this.s.getStatus())

    if (recoveryDepth > 0) {
      this.s.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'failed',
        content: 'Session recovery failed. Please start a new conversation.'
      } as StreamChunk)
    }

    this.s.emit('complete')
  }

  // ── Plan State Persistence ────────────────────────────────────────────

  saveCurrentPlanState(conversationId: string): void {
    if (!this.s.workspaceId || this.s.currentMode !== 'plan') return
    try {
      const filesExplored = this.s.toolActivityAccumulator.getExploredFiles()
      const text = this.s.accumulatedText

      const planLineRegex =
        /^\s*(?:\d+[.)]\s|[-*]\s|#{2,4}\s(?:Step|Phase|Change|Modify|Add|Remove|Update|Create|Fix|Implement)|\*{1,2}\d+[.)]\*{0,2}\s)/i
      const planItems = text
        .split('\n')
        .filter((line) => planLineRegex.test(line))
        .slice(0, 30)
        .map((line) => line.trim())

      const discoveredContext: DiscoveredContext = {
        filesExplored,
        keyFindings: [],
        planItems,
        nextSteps: []
      }

      const originalRequest =
        typeof this.s.lastStreamOpts?.sdkPrompt === 'string'
          ? (this.s.lastStreamOpts.sdkPrompt as string).slice(0, 2000)
          : ''

      localPlanStateService.upsert({
        conversationId,
        workspaceId: this.s.workspaceId,
        originalRequest,
        discoveredContext,
        planText: text.slice(0, 10_000)
      })
    } catch (err) {
      this.s.log.warn('[S3:plan-state-save-failed]', err)
    }
  }

  // ── Structured Summary Extraction ─────────────────────────────────────

  extractStructuredSummary(_conversationId: string): string | null {
    const text = this.s.accumulatedText
    if (!text || text.length < 50) return null

    const filesExplored = this.s.toolActivityAccumulator.getExploredFiles()
    const toolCount = this.s.toolActivityAccumulator.count

    const planLineRegex =
      /^\s*(?:\d+[.)]\s|[-*]\s|#{2,4}\s(?:Step|Phase|Change|Modify|Add|Remove|Update|Create|Fix|Implement)|\*{1,2}\d+[.)]\*{0,2}\s)/i
    const planItems = text
      .split('\n')
      .filter((line) => planLineRegex.test(line))
      .slice(0, 20)
      .map((line) => line.trim())

    const parts: string[] = []

    const originalRequest = this.s.lastStreamOpts?.sdkPrompt
    if (typeof originalRequest === 'string') {
      parts.push(`## Goal\n${originalRequest.slice(0, 300)}`)
    }

    if (filesExplored.length > 0) {
      parts.push(`## Files Found\n${filesExplored.map((f) => `- ${f}`).join('\n')}`)
    }

    const nonPlanText = text
      .split('\n')
      .filter((line) => !planLineRegex.test(line))
      .join('\n')
      .trim()
    if (nonPlanText.length > 50) {
      parts.push(`## Key Findings\n${nonPlanText.slice(0, 500)}`)
    }

    if (planItems.length > 0) {
      parts.push(`## Plan So Far\n${planItems.join('\n')}`)
    }

    if (toolCount > 0) {
      parts.push(`## Session Stats\nTool calls: ${toolCount}`)
    }

    if (parts.length === 0) return null
    return parts.join('\n\n')
  }
}
