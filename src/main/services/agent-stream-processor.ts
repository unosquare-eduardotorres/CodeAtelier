/**
 * AgentStreamProcessor — handles stream chunk processing, token tracking,
 * context pressure evaluation, and compaction threshold management.
 *
 * Extracted from AgentSessionService to reduce god-class complexity.
 * Holds a back-reference to the session for state access.
 *
 * @internal Not for use outside the agent-session module.
 */

import type {
  AgentSessionHost,
  StreamLoopState,
  StreamChunk,
  ExecutorResult
} from './agent-session-host'
import type { ContextWindowTier } from './context-management'
import type { ModelAction } from '../../shared/types'
import {
  CLAUDE_DEFAULT_CONTEXT_WINDOW,
  CLAUDE_1M_CONTEXT_WINDOW,
  MCP_TOOLS
} from '../../shared/constants'
import { resolveContextTier } from './context-management'
import {
  classifyCompaction,
  resolveCompactionThresholds as resolveCompactionThresholdsPolicy,
  resolveAppliedThresholds
} from './compaction-policy'
import { modelConfigService } from './model-config.service'
import { supportsContext1M } from '../../shared/constants'
import { conversationRepository, turnUsageRepository } from '../db/repositories'

export class AgentStreamProcessor {
  private readonly s: AgentSessionHost

  constructor(session: unknown) {
    this.s = session as AgentSessionHost
  }

  // ── processMetaChunk ──────────────────────────────────────────────────

  async processMetaChunk(
    meta: ExecutorResult,
    ctx: {
      conversationId: string
      turnCount: number
      streamState: StreamLoopState
    }
  ): Promise<void> {
    const { conversationId, turnCount, streamState } = ctx
    streamState.messageStopReceived = true

    if (meta.sessionId && conversationId) {
      this.s.sessionMap.set(conversationId, meta.sessionId)
      this.s.log.info('Session captured for conversation:', conversationId)
      try {
        conversationRepository.updateSessionId(conversationId, meta.sessionId)
      } catch (err) {
        this.s.log.error('Failed to persist session ID:', err)
      }
    }

    if (meta.sessionTitle && conversationId) {
      try {
        const conv = conversationRepository.findById(conversationId)
        if (conv && (conv.title === 'New Conversation' || conv.title === '')) {
          conversationRepository.updateTitle(conversationId, meta.sessionTitle)
          this.s.log.info(`[PIPELINE:auto-title] "${meta.sessionTitle}" for ${conversationId}`)
        }
      } catch (err) {
        this.s.log.warn('Failed to auto-name conversation from session_title:', err)
      }
    }

    if (meta.terminalReason) {
      streamState.lastTerminalReason = meta.terminalReason
      this.s.log.info(`[PIPELINE:terminal-reason] ${meta.terminalReason} for ${conversationId}`)
    }

    const { totalTokens } = this.s.tokenTracker.recordTurn(meta, {
      turnCount,
      conversationId,
      dbSessionId: this.s.dbSessionId,
      workspacePath: this.s.workspacePath!
    })
    this.s.tokenUsage += totalTokens
    this.s.inputTokens += meta.tokenUsage.input
    this.s.outputTokens += meta.tokenUsage.output
    this.s.cacheReadTokens += meta.tokenUsage.cacheReadInputTokens
    this.s.cacheCreationTokens += meta.tokenUsage.cacheCreationInputTokens

    // Context-window occupancy = the prompt size of the LATEST API round-trip
    // (input + cache_read + cache_creation of the most recent message_start),
    // exposed by the executor as contextWindowTokens.
    //
    // We deliberately do NOT sum these fields across the turn: a single user
    // message drives an agentic loop with many round-trips, each re-reading the
    // full cached context. Summing cache_read across round-trips over-counts
    // occupancy ~5-10x (a plan turn would report ~42% of a 1M window after one
    // message). The snapshot reflects true current occupancy.
    //
    // Fallback to the summed totals only when the backend doesn't report a
    // per-call snapshot (e.g. OpenCode, or a stream with no message_start usage).
    const summedContextTokens =
      meta.tokenUsage.input +
      meta.tokenUsage.cacheReadInputTokens +
      meta.tokenUsage.cacheCreationInputTokens
    const contextWindowTokens = meta.tokenUsage.contextWindowTokens ?? 0
    const totalContextTokens =
      contextWindowTokens > 0 ? contextWindowTokens : summedContextTokens
    const consumedContextTokens = totalContextTokens

    // Update lastContextTokens for all backends (badge, compact modal, etc.)
    this.s.lastContextTokens = totalContextTokens

    // Push live context update to the renderer
    if (consumedContextTokens > 0) {
      const effectiveWindow = this.s.effectiveContextWindow ?? CLAUDE_DEFAULT_CONTEXT_WINDOW
      // F11: Reuse token tracker's cache efficiency calculation (single source of truth)
      // instead of duplicating the cacheRead / (input + cacheRead) formula here.
      const cacheReport = this.s.tokenTracker.getCacheEfficiency()
      const cacheHitRate = Math.round(cacheReport.hitRate)
      this.s.emit('chunk', {
        type: 'context_usage_update',
        content: '',
        contextUsageUpdate: {
          inputTokens: consumedContextTokens,
          contextWindowSize: effectiveWindow,
          percentage: Math.round((consumedContextTokens / effectiveWindow) * 100),
          cacheHitRate
        }
      } as StreamChunk)
    }

    this.checkCompaction(totalContextTokens)

    // Evaluate context pressure for local LLMs AND Claude 200K models.
    const isLocal = this.s.llmProvider === 'local-llm'
    const effectiveWindow = this.s.effectiveContextWindow
    const is200KClaude = !isLocal && effectiveWindow != null && effectiveWindow <= 200_000
    if (isLocal || is200KClaude) {
      const ctxWindow = isLocal
        ? (effectiveWindow ?? this.s.resolveLocalContextWindow())
        : effectiveWindow!
      const pressureRatio = consumedContextTokens / ctxWindow
      if (pressureRatio > 0.85) {
        this.s.emit('chunk', {
          type: 'text',
          content: `\n\n> ⚠️ Context window is ${Math.round(pressureRatio * 100)}% full — consider compacting.\n\n`
        } as StreamChunk)
      }
    }

    // F3: Persist per-turn context tokens to DB for dashboard analytics.
    // Previously referenced undefined `sdkContextData` — now uses the
    // `totalContextTokens` already computed above from CLI token usage fields.
    if (this.s.dbSessionId && conversationId && totalContextTokens > 0) {
      try {
        turnUsageRepository.updateLastTurnContextTokens(conversationId, totalContextTokens)
      } catch (err) {
        this.s.log.warn('Failed to persist context tokens:', err)
      }
    }
  }

  // ── processContentChunk ───────────────────────────────────────────────

  processContentChunk(
    chunk: StreamChunk & { type?: string; content?: string; error?: string; toolName?: string },
    ctx: {
      conversationId: string
      isBuildMode: boolean
      streamState: StreamLoopState
      contextTier?: ContextWindowTier
    }
  ): 'next' | 'break' | 'continue' | 'return' {
    const { conversationId, isBuildMode, streamState } = ctx

    if (chunk.type === 'error' && chunk.error?.includes('No conversation found with session ID')) {
      this.s.log.warn(
        `[PIPELINE:session-recovery] Stale session detected for conversationId=${conversationId} — initiating recovery`
      )

      this.s.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'started',
        content: 'Session expired — recovering conversation context...'
      } as StreamChunk)

      this.s.clearSession(conversationId)
      try {
        conversationRepository.updateSessionId(conversationId, '')
      } catch (err) {
        this.s.log.error('[PIPELINE:session-recovery] Failed to clear DB session:', err)
      }

      this.s.emit('chunk', {
        type: 'session_recovery',
        recoveryPhase: 'building_context',
        content: 'Rebuilding conversation context from history...'
      } as StreamChunk)

      streamState.sessionRecoveryNeeded = true
      return 'break'
    }

    // Intercept SDK abort errors that weren't user-initiated
    if (
      chunk.type === 'error' &&
      chunk.error?.includes('Claude Code process aborted by user') &&
      this.s.currentStatus !== 'idle'
    ) {
      this.s.log.warn(
        `[PIPELINE:unexpected-abort] Session was aborted without user action — ` +
          `status=${this.s.currentStatus} conversationId=${conversationId}`
      )
      this.s.emit('chunk', {
        type: 'error',
        error:
          'The agent session was interrupted unexpectedly. This can happen during app reloads. Please resend your message to continue.'
      } as StreamChunk)
      return 'break'
    }

    // Intercept budget cap exceeded
    if (chunk.type === 'error' && chunk.error?.includes('budget cap exceeded')) {
      this.s.log.warn(
        `[PIPELINE:budget-cap-reached] conversationId=${conversationId} — offering continuation`
      )
      this.s.emit('budgetCapReached', {
        conversationId,
        message: chunk.error
      })
      return 'break'
    }

    if (chunk.type === 'text' && chunk.content) {
      this.s.accumulatedText += chunk.content
      streamState.hasTextAfterLastTool = true
    }

    if (chunk.type === 'tool_use') {
      const isControlTool = chunk.toolName?.startsWith(MCP_TOOLS.CONTROL_ACTIONS._PREFIX)
      if (isControlTool) {
        this.s.log.debug(`[PIPELINE:control-tool-use] ${chunk.toolName}`)
        return 'continue'
      }

      this.s.toolActivityAccumulator.record({
        toolName: chunk.toolName ?? 'unknown',
        input: (chunk as unknown as Record<string, unknown>).toolInput,
        outputLength: chunk.content?.length ?? 0
      })

      streamState.hasTextAfterLastTool = false
      const isLocalForCb = this.s.llmProvider === 'local-llm'
      const cbResult = this.s.circuitBreaker.onToolUse({
        isBuildMode,
        accumulatedTextLength: this.s.accumulatedText.length,
        conversationId,
        isLocalProvider: isLocalForCb,
        contextTier: ctx.contextTier
      })

      // Emit early warning nudge
      if (cbResult.additionalContext) {
        this.s.emit('chunk', {
          type: 'text',
          content: `\n\n> ⚠️ ${cbResult.additionalContext}\n\n`
        } as StreamChunk)
      }

      if (cbResult.broken) {
        // Local plan mode: treat as a continuable turn-limit rather than a hard error.
        // Save plan state and let finalizeStream → handleResponseComplete auto-continue.
        if (cbResult.isLocalPlanBreak) {
          this.s.log.info(
            `[PIPELINE:local-plan-break] Circuit breaker fired for local plan — ` +
              `saving progress and allowing auto-continuation`
          )
          streamState.lastTerminalReason = 'max_turns'
          // Save partial plan state so continuation has context
          if (conversationId) {
            this.s.saveCurrentPlanState(conversationId)
          }
          return 'break'
        }

        this.s.currentStatus = 'failed'
        this.s.emit('statusUpdate', this.s.getStatus())
        if (cbResult.errorChunk) {
          this.s.emit('chunk', cbResult.errorChunk)
        }
        this.s.emit('complete')
        return 'return'
      }

      this.s.circuitBreaker.logToolCall(conversationId, chunk.toolName ?? 'unknown')
    }

    if (chunk.type === 'subagent_start') {
      // Count sub-agent spawns against the circuit breaker — each sub-agent
      // makes 20-90+ internal tool calls that bypass the normal tool_use count.
      // Count the spawn itself as 10 tool calls (conservative estimate of cost).
      for (let i = 0; i < 10; i++) {
        const cbResult = this.s.circuitBreaker.onToolUse({
          isBuildMode,
          accumulatedTextLength: this.s.accumulatedText.length,
          conversationId,
          isLocalProvider: this.s.llmProvider === 'local-llm',
          contextTier: ctx.contextTier
        })
        if (cbResult.broken) {
          this.s.log.warn(
            `[PIPELINE:subagent-circuit-break] Sub-agent spawn tripped circuit breaker at ${this.s.circuitBreaker.count} tool calls`
          )
          if (cbResult.errorChunk) {
            this.s.emit('chunk', cbResult.errorChunk)
          }
          return 'break'
        }
      }
    }

    // F12: Removed dead `promptSuggestion` event emission — no listener exists.
    // The chunk is already forwarded to the renderer via emit('chunk', chunk) below,
    // which the chunk-router routes through handlePromptSuggestion.

    if (chunk.type === 'text') this.s.currentStatus = 'writing'
    if (chunk.type === 'tool_use') this.s.currentStatus = 'reviewing'
    this.s.emit('statusUpdate', this.s.getStatus())
    this.s.emit('chunk', chunk)
    return 'next'
  }

  // ── Compaction ────────────────────────────────────────────────────────

  checkCompaction(
    inputTokens: number,
    breakdown?: import('../../shared/types').ContextUsageBreakdown
  ): void {
    const autoThreshold = this.s.compactAutoThreshold
    const suggestThreshold = this.s.compactSuggestThreshold
    const isLocal = this.s.llmProvider === 'local-llm'
    const isAutoCompactEnabled = breakdown?.isAutoCompactEnabled === true

    // Instrumentation: surface the resolved thresholds with every band decision
    // so live runs are observable (Part 3 of the compaction-verification plan).
    this.s.log.info(
      `[compaction:thresholds] inputTokens=${inputTokens} suggest=${suggestThreshold} ` +
        `auto=${autoThreshold} isAutoCompactEnabled=${isAutoCompactEnabled} isLocal=${isLocal}`
    )

    // Pure band classification — all emit/log/state below is side-effect only.
    const decision = classifyCompaction({
      inputTokens,
      suggestThreshold,
      autoThreshold,
      isAutoCompactEnabled,
      compactSuggested: this.s.compactSuggested,
      turnsSinceCompactSuggestion: this.s.turnsSinceCompactSuggestion
    })

    // F15: commit debounce state (reset below warning, advance on debounced suggest).
    this.s.compactSuggested = decision.nextSuggested
    this.s.turnsSinceCompactSuggestion = decision.nextTurns

    if (!decision.level) return

    if (decision.level === 'auto-compact-pending' || decision.level === 'critical') {
      this.s.log.warn(
        `[PIPELINE:compact-critical] Context at ${inputTokens} tokens ` +
          `(threshold=${autoThreshold}) — ${decision.level === 'auto-compact-pending' ? 'SDK auto-compact will handle' : 'critical notification'}`
      )
      this.s.emit('compactNeeded', {
        level: decision.level,
        inputTokens,
        breakdown,
        isLocalProvider: isLocal
      })
      return
    }

    if (decision.level === 'suggest') {
      this.s.log.info(`Context growing large (${inputTokens} input tokens) — suggesting compact`)
      this.s.emit('compactNeeded', {
        level: 'suggest',
        inputTokens,
        breakdown,
        isLocalProvider: isLocal
      })
      return
    }

    // warning
    this.s.log.info(
      `[PIPELINE:compact-warning] Context approaching threshold (${inputTokens}/${suggestThreshold} tokens)`
    )
    this.s.emit('compactNeeded', {
      level: 'warning',
      inputTokens,
      estimatedNextCost: Math.round(inputTokens * 0.05),
      breakdown,
      isLocalProvider: isLocal
    })
  }

  applyCompactionThresholds(settings: Record<string, unknown>): void {
    const isLocal = (settings.llmProvider as string) === 'local-llm'

    if (isLocal) {
      const ctx = this.s.resolveLocalContextWindow()
      const tier = resolveContextTier(ctx)
      const { suggest, auto } = resolveAppliedThresholds({ isLocal: true, localTier: tier })
      this.s.compactSuggestThreshold = suggest
      this.s.compactAutoThreshold = auto
    } else {
      const modelAction = `${this.s.adapter.role}:${this.s.currentMode}` as ModelAction
      const model = modelConfigService.getModel(this.s.workspacePath!, modelAction)
      const supports1M = supportsContext1M(model)
      const effectiveWindow = supports1M ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_DEFAULT_CONTEXT_WINDOW
      const { suggest, auto } = resolveAppliedThresholds({
        isLocal: false,
        effectiveContextWindow: effectiveWindow,
        userSuggestThreshold: settings.compactSuggestThreshold as number | undefined,
        userAutoThreshold: settings.compactAutoThreshold as number | undefined
      })
      this.s.compactSuggestThreshold = suggest
      this.s.compactAutoThreshold = auto
    }
  }

  resolveCompactionThresholds(effectiveContextWindow: number): {
    suggest: number
    auto: number
  } {
    return resolveCompactionThresholdsPolicy(effectiveContextWindow)
  }
}
