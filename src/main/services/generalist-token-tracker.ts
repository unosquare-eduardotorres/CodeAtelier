import type { SDKExecuteResult } from './sdk-executor'
import { turnUsageRepository } from '../db/repositories'
import { modelConfigService } from './model-config.service'
import { generalistLogger } from '../logger'

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
 * Extracts token/cost tracking from GeneralistService.
 *
 * Responsibilities:
 * - Accumulate prompt cache statistics (Strategy M)
 * - Record per-turn cost breakdowns (Strategy θ)
 * - Persist turn usage to DB via turnUsageRepository
 * - Detect token growth spikes
 * - Expose cache efficiency metrics for the dashboard
 */
export class GeneralistTokenTracker {
  private readonly log = generalistLogger

  /** Strategy M: Aggregate prompt cache statistics for dashboard */
  private cacheStats = { totalInput: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }

  /** Strategy θ: Per-turn cost breakdown for diagnostics */
  private turnBreakdown: TurnBreakdownEntry[] = []

  /**
   * Process an SDK meta chunk — records cache stats, turn breakdown, and DB usage.
   * Returns the total tokens consumed (input + output) for the caller to accumulate.
   */
  recordTurn(
    meta: SDKExecuteResult,
    opts: {
      turnCount: number
      conversationId: string
      dbSessionId: string | null
      workspacePath: string
    }
  ): { totalTokens: number } {
    const { cacheReadInputTokens, cacheCreationInputTokens } = meta.tokenUsage
    const totalTokens = meta.tokenUsage.input + meta.tokenUsage.output

    // S8 + Strategy M: Log prompt cache effectiveness
    if (cacheReadInputTokens > 0 || cacheCreationInputTokens > 0) {
      const totalInput =
        meta.tokenUsage.input + cacheReadInputTokens + cacheCreationInputTokens
      const cacheHitRate = totalInput > 0 ? (cacheReadInputTokens / totalInput) * 100 : 0
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
    const totalInputForRate =
      meta.tokenUsage.input + cacheReadInputTokens + cacheCreationInputTokens
    this.turnBreakdown.push({
      turn: opts.turnCount,
      inputTokens: meta.tokenUsage.input,
      outputTokens: meta.tokenUsage.output,
      cacheReadTokens: cacheReadInputTokens,
      cacheCreationTokens: cacheCreationInputTokens,
      cacheHitRate:
        totalInputForRate > 0 ? (cacheReadInputTokens / totalInputForRate) * 100 : 0,
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
          model: modelConfigService.getModel(opts.workspacePath, 'generalist')
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

    return { totalTokens }
  }

  /**
   * Strategy M: Returns prompt cache efficiency metrics for dashboard display.
   * Tracks cumulative cache read/creation across all turns for this session.
   */
  getCacheEfficiency(): CacheEfficiencyReport {
    const totalWithCache =
      this.cacheStats.totalInput + this.cacheStats.cacheRead + this.cacheStats.cacheCreation
    const hitRate = totalWithCache > 0 ? (this.cacheStats.cacheRead / totalWithCache) * 100 : 0
    return {
      hitRate,
      savedTokens: this.cacheStats.cacheRead,
      totalInput: this.cacheStats.totalInput,
      turns: this.cacheStats.turns,
      turnBreakdown: this.turnBreakdown
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
