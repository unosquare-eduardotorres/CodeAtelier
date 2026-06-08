import type { ExecutorResult } from './executor-types'
import { turnUsageRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { usageTrackerService } from './usage-tracker.service'
import { chatAgentLogger } from '../logger'

/**
 * Per-turn cost breakdown entry for diagnostics.
 * Strategy θ: Tracks input/output/cache tokens per turn to identify cost hot spots.
 * Exposed via getCacheEfficiency() for the renderer cost waterfall chart.
 */
export interface TurnBreakdownEntry {
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cacheHitRate: number
  timestamp: number
}

/**
 * Cache efficiency report returned to the renderer dashboard.
 */
export interface CacheEfficiencyReport {
  hitRate: number
  savedTokens: number
  totalInput: number
  turns: number
  /** Strategy θ: Per-turn cost breakdown for cost waterfall chart */
  turnBreakdown: TurnBreakdownEntry[]
}

/**
 * Extracts token/cost tracking from ChatAgentService.
 *
 * Responsibilities:
 * - Accumulate prompt cache statistics (Strategy M)
 * - Record per-turn cost breakdowns (Strategy θ)
 * - Persist turn usage to DB via turnUsageRepository
 * - Detect token growth spikes
 * - Expose cache efficiency metrics for the dashboard
 */
export class AgentTokenTracker {
  private readonly log = chatAgentLogger

  /** Strategy M: Aggregate prompt cache statistics for dashboard */
  private cacheStats = { totalInput: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }

  /** Strategy θ: Per-turn cost breakdown for diagnostics */
  private turnBreakdown: TurnBreakdownEntry[] = []

  /**
   * Process an SDK meta chunk — records cache stats, turn breakdown, and DB usage.
   * Returns the total tokens consumed (input + output) for the caller to accumulate.
   */
  recordTurn(
    meta: ExecutorResult,
    opts: {
      turnCount: number
      conversationId: string
      dbSessionId: string | null
      workspacePath: string
      /** Unified usage_log feature bucket (chat|grill|council|mpa|audit). */
      feature?: string
      /** adapter.agentId for the session flow. */
      agentType?: string
      /** ACTUAL resolved model used for this turn. */
      model?: string
      /** Workspace id (nullable). */
      workspaceId?: string | null
    }
  ): { totalTokens: number } {
    const { cacheReadInputTokens, cacheCreationInputTokens } = meta.tokenUsage
    const totalTokens = meta.tokenUsage.input + meta.tokenUsage.output

    // Diagnostic: raw SDK token values to determine overlap semantics
    // (input_tokens inclusive vs exclusive of cache tokens)
    this.log.info(
      `[PIPELINE:token-debug] turn=${opts.turnCount} ` +
        `input=${meta.tokenUsage.input} output=${meta.tokenUsage.output} ` +
        `cacheRead=${cacheReadInputTokens} cacheCreation=${cacheCreationInputTokens} ` +
        `sum=${meta.tokenUsage.input + cacheReadInputTokens + cacheCreationInputTokens}`
    )

    // S8 + Strategy M: Log prompt cache effectiveness
    // Hit rate = cacheRead / (input + cacheRead). cacheCreation is a separate write cost, not input processing.
    if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
      const effectiveInput = meta.tokenUsage.input + cacheReadInputTokens
      const cacheHitRate = effectiveInput > 0 ? (cacheReadInputTokens / effectiveInput) * 100 : 0
      this.log.info(
        `[PIPELINE:prompt-cache] read=${cacheReadInputTokens} creation=${cacheCreationInputTokens} hitRate=${cacheHitRate.toFixed(1)}%`
      )
    }

    // Strategy M: Accumulate cache stats for dashboard
    this.cacheStats.totalInput += meta.tokenUsage.input
    this.cacheStats.cacheRead += cacheReadInputTokens
    this.cacheStats.cacheCreation += cacheCreationInputTokens
    this.cacheStats.turns++

    // Strategy θ: Per-turn cost breakdown for diagnostics
    // Hit rate denominator excludes cacheCreation (write cost, not input processing)
    const effectiveInputForRate = meta.tokenUsage.input + cacheReadInputTokens
    this.turnBreakdown.push({
      turn: opts.turnCount,
      inputTokens: meta.tokenUsage.input,
      outputTokens: meta.tokenUsage.output,
      cacheReadTokens: cacheReadInputTokens,
      cacheCreationTokens: cacheCreationInputTokens,
      cacheHitRate:
        effectiveInputForRate > 0 ? (cacheReadInputTokens / effectiveInputForRate) * 100 : 0,
      timestamp: Date.now()
    })

    // Per-turn token breakdown storage — enables cost debugging and cache rate trends
    if (opts.dbSessionId && opts.conversationId) {
      try {
        const previousTurn = turnUsageRepository.getLastTurn(opts.conversationId)
        turnUsageRepository.record({
          sessionId: opts.dbSessionId,
          conversationId: opts.conversationId,
          turnNumber: opts.turnCount,
          inputTokens: meta.tokenUsage.input,
          outputTokens: meta.tokenUsage.output,
          cacheReadTokens: cacheReadInputTokens,
          cacheCreationTokens: cacheCreationInputTokens,
          model: opts.model ?? modelConfigService.getModel(opts.workspacePath, 'da-vinci')
        })
        // Token growth rate alert — warn if input tokens spiked >30%
        if (previousTurn && previousTurn.inputTokens > 0) {
          const growthRate =
            (meta.tokenUsage.input - previousTurn.inputTokens) / previousTurn.inputTokens
          if (growthRate > 0.3) {
            this.log.warn(
              `[PIPELINE:token-spike] ${(growthRate * 100).toFixed(0)}% input growth (${previousTurn.inputTokens} → ${meta.tokenUsage.input}) — possible context explosion`
            )
          }
        }
      } catch (err) {
        this.log.error('Failed to record turn usage:', err)
      }
    }

    // Unified usage_log sink — records EVERY session turn with correct attribution
    // (real model + feature), independent of the turn_usage analytics write above.
    // Note: no getModel() fallback here — that would hit the DB on every turn; the
    // caller (stream processor) always supplies the resolved model.
    usageTrackerService.recordUsage({
      feature: opts.feature ?? 'chat',
      agentType: opts.agentType ?? null,
      model: opts.model ?? null,
      workspaceId: opts.workspaceId ?? null,
      conversationId: opts.conversationId,
      sessionId: opts.dbSessionId,
      turnNumber: opts.turnCount,
      tokens: {
        input: meta.tokenUsage.input,
        output: meta.tokenUsage.output,
        cacheRead: cacheReadInputTokens,
        cacheCreation: cacheCreationInputTokens
      }
    })

    return { totalTokens }
  }

  /**
   * Strategy M: Returns prompt cache efficiency metrics for dashboard display.
   * Tracks cumulative cache read/creation across all turns for this session.
   * Falls back to DB-persisted turn_usage data when in-memory stats are empty (e.g. after restart).
   */
  getCacheEfficiency(conversationId?: string | null): CacheEfficiencyReport {
    // If in-memory stats are available, use them (hot path during active session)
    if (this.cacheStats.turns > 0) {
      // Hit rate = cacheRead / (input + cacheRead). Excludes cacheCreation (write cost).
      const effectiveInput = this.cacheStats.totalInput + this.cacheStats.cacheRead
      const hitRate = effectiveInput > 0 ? (this.cacheStats.cacheRead / effectiveInput) * 100 : 0
      return {
        hitRate,
        savedTokens: this.cacheStats.cacheRead,
        totalInput: this.cacheStats.totalInput,
        turns: this.cacheStats.turns,
        turnBreakdown: this.turnBreakdown
      }
    }

    // Fall back to DB-persisted turn_usage data (cold path after app restart)
    if (conversationId) {
      try {
        const dbTurns = turnUsageRepository.findByConversation(conversationId)
        if (dbTurns.length > 0) {
          let totalInput = 0
          let totalCacheRead = 0
          const turnBreakdown: TurnBreakdownEntry[] = dbTurns.map((t) => {
            totalInput += t.inputTokens
            totalCacheRead += t.cacheReadTokens
            const effectiveForRate = t.inputTokens + t.cacheReadTokens
            return {
              turn: t.turnNumber,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              cacheReadTokens: t.cacheReadTokens,
              cacheCreationTokens: t.cacheCreationTokens,
              cacheHitRate: effectiveForRate > 0 ? (t.cacheReadTokens / effectiveForRate) * 100 : 0,
              timestamp: new Date(t.createdAt).getTime()
            }
          })
          // Hit rate excludes cacheCreation — it's a write cost, not input processing
          const effectiveTotal = totalInput + totalCacheRead
          const hitRate = effectiveTotal > 0 ? (totalCacheRead / effectiveTotal) * 100 : 0
          return {
            hitRate,
            savedTokens: totalCacheRead,
            totalInput,
            turns: dbTurns.length,
            turnBreakdown
          }
        }
      } catch (err) {
        this.log.error('Failed to load turn usage from DB for cache efficiency:', err)
      }
    }

    // No data available
    return {
      hitRate: 0,
      savedTokens: 0,
      totalInput: 0,
      turns: 0,
      turnBreakdown: []
    }
  }

  /** Reset all tracking state — called at start of each send() */
  reset(): void {
    // Note: we do NOT reset cacheStats or turnBreakdown here — those accumulate
    // across the entire session. Only per-turn state is reset.
  }

  /** Full reset — called on session start */
  resetSession(): void {
    this.cacheStats = { totalInput: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }
    this.turnBreakdown = []
  }
}
