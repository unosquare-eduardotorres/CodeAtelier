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
import type { AgentIntent, LLMProvider, ModelAction } from '../../shared/types'
import type { AdapterMcpResult } from './agent-session.types'
import { modelConfigService } from './model-config.service'
import { conversationRepository } from '../db/repositories'
import { localPlanStateService } from './local-plan-state.service'
import type { DiscoveredContext } from './local-plan-state.service'

// N8: Single source of truth for the turn-limit-exhausted message
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

    await this.s.executeStream({
      sdkPrompt: continuationPrompt,
      systemPrompt,
      sessionId: isLocal ? undefined : this.s.sessionMap.get(conversationId),
      conversationId,
      turnCount: this.s.turnCounts.get(conversationId) ?? 1,
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

    // ── Auto-continue on max_turns (also triggered by local plan circuit breaker) ──
    // BUT: skip if the underlying cause was API overload — retrying is pointless
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
      return
    }

    if (
      streamState.lastTerminalReason === 'max_turns' &&
      this.s.maxTurnsContinuations < SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      // N7: Shared continuation logic
      await this.continueTurnLimit({
        conversationId,
        systemPrompt,
        isBuildMode,
        mcpResult,
        llmProvider,
        recoveryDepth
      })
      return // executeStream handles its own finalization
    }

    // All auto-continuations exhausted
    if (
      streamState.lastTerminalReason === 'max_turns' &&
      this.s.maxTurnsContinuations >= SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      this.s.log.info(
        `[PIPELINE:max-turns-exhausted] All ${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS} ` +
          `continuations used — emitting graceful wrap-up for conversationId=${conversationId}`
      )
      this.s.emit('chunk', {
        type: 'text',
        content: TURN_LIMIT_EXHAUSTED_MSG
      } as StreamChunk)
    }

    // ── Plan-mode tool-block recovery ───────────────────────────────────────
    // The model tried a blocked Write/Edit in Plan mode (auto-flagged by the
    // stream processor). Fire a deterministic emit_plan recovery so the user
    // still gets a plan card. Skip the silent-completion nudge below if we do.
    let planRecoveryAttempted = false
    if (
      streamState.planModeToolBlock &&
      this.s.currentMode === 'plan' &&
      !this.s.controlToolState.plan &&
      !timedOut
    ) {
      try {
        const result = await this.s.recoveryNudge.attemptPlanToolRecovery({
          cliExecutor: this.s.cliExecutor,
          systemPrompt,
          workspacePath: this.s.workspacePath!,
          model: modelConfigService.getModel(
            this.s.workspacePath!,
            this.s.adapter.role as ModelAction
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
        // Continue finalization without plan tool recovery
      }
    }

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
        model: modelConfigService.getModel(
          this.s.workspacePath!,
          this.s.adapter.role as ModelAction
        ),
        isBuildMode,
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

      // Save plan state for cross-session continuity (local LLMs only)
      if (llmProvider === 'local-llm') {
        this.saveCurrentPlanState(conversationId)
      }
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

  // ── handleStreamError ─────────────────────────────────────────────────

  async handleStreamError(
    error: Error,
    timedOut: boolean,
    recoveryDepth = 0,
    effectiveTimeoutMs?: number
  ): Promise<void> {
    this.s.sdkAbortController = null

    // Save partial progress on error (local LLMs)
    if (
      this.s.llmProvider === 'local-llm' &&
      this.s.accumulatedText.length > 50 &&
      this.s.currentConversationId
    ) {
      try {
        const summary = this.extractStructuredSummary(this.s.currentConversationId)
        if (summary) {
          conversationRepository.updateSummary(this.s.currentConversationId, summary)
          this.s.log.info(
            `[S6:error-summary-saved] conversationId=${this.s.currentConversationId} len=${summary.length}`
          )
        }
      } catch {
        /* non-fatal */
      }
      this.saveCurrentPlanState(this.s.currentConversationId)
    }

    // ── Detect API overload errors — don't auto-continue ──
    const isOverload =
      !timedOut &&
      error.name !== 'AbortError' &&
      /529|overloaded|server_is_overloaded|503 Service/i.test(error.message)

    if (isOverload) {
      this.s.log.warn(`[PIPELINE:overload-error] API overload error: ${error.message}`)
      this.s.emit('chunk', {
        type: 'text',
        content:
          '\n\n---\n\n' +
          '⚠️ **Claude is temporarily overloaded** — the API returned server errors during this session. ' +
          'This is a server-side issue and not a problem with your request.\n\n' +
          'Try again in a few minutes. If it persists, check [status.claude.com](https://status.claude.com).'
      } as StreamChunk)
      this.s.currentStatus = 'idle'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return
    }

    // ── Auto-continue on max_turns error ──
    const isMaxTurns =
      !timedOut && error.name !== 'AbortError' && error.message?.includes('maximum number of turns')

    if (
      isMaxTurns &&
      this.s.lastStreamOpts &&
      this.s.maxTurnsContinuations < SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS
    ) {
      // N7: Shared continuation logic
      const { conversationId, systemPrompt, isBuildMode, mcpResult, llmProvider } =
        this.s.lastStreamOpts
      await this.continueTurnLimit({
        conversationId,
        systemPrompt,
        isBuildMode,
        mcpResult,
        llmProvider,
        recoveryDepth
      })
      return
    }

    // Max turns as SDK error — all continuations exhausted
    if (isMaxTurns) {
      this.s.log.info(
        `[PIPELINE:max-turns-exhausted-error] All ${SESSION_CONSTANTS.MAX_TURN_CONTINUATIONS} ` +
          'continuations used (error path) — emitting graceful wrap-up'
      )
      this.s.emit('chunk', {
        type: 'text',
        content: TURN_LIMIT_EXHAUSTED_MSG
      } as StreamChunk)
      this.s.currentStatus = 'idle'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return
    }

    // Context overflow detection — graceful handling for local LLMs
    const isContextOverflow =
      !timedOut &&
      error.name !== 'AbortError' &&
      this.s.llmProvider === 'local-llm' &&
      (error.message?.includes('context length') ||
        error.message?.includes('maximum context') ||
        error.message?.includes('too many tokens') ||
        error.message?.includes('exceeds max context') ||
        error.message?.includes('context window') ||
        error.message?.includes('token limit'))

    if (isContextOverflow && this.s.currentConversationId) {
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

      this.s.currentStatus = 'idle'
      this.s.flushTokenUsage()
      this.s.emit('statusUpdate', this.s.getStatus())
      this.s.emit('complete')
      return
    }

    if (error.name === 'AbortError') {
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
    } else {
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
