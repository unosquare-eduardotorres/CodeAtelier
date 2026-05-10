import log from 'electron-log/main'
import { EventEmitter } from 'node:events'
import { getDatabase } from '../db'
import { agentSessionRepository, workspaceRepository } from '../db/repositories'
import { eventLoggerService } from './event-logger.service'

const costLogger = log.scope('CostTracker')

/**
 * Model pricing table — $/1M tokens for input and output.
 * Based on Claude pricing as of March 2026.
 * Updated model IDs should be added here as new models are released.
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Current models
  'claude-haiku-4-5-20251001': { inputPer1M: 1.0, outputPer1M: 5.0 },
  'claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-7': { inputPer1M: 5.0, outputPer1M: 25.0 },
  // Legacy (kept for historical cost calculation on older sessions)
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-opus-4-20250514': { inputPer1M: 15.0, outputPer1M: 75.0 },
  'claude-opus-4-6': { inputPer1M: 5.0, outputPer1M: 25.0 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.0, outputPer1M: 15.0 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4.0 }
} as const

/** Default pricing when model is unknown */
const DEFAULT_PRICING = { inputPer1M: 3.0, outputPer1M: 15.0 }

/** Budget thresholds */
const BUDGET_WARNING_PERCENT = 80
const BUDGET_HARD_STOP_PERCENT = 100

/**
 * Estimates cost in cents from token counts and model ID.
 */
export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  modelId?: string
): number {
  const pricing = modelId ? (MODEL_PRICING[modelId] ?? DEFAULT_PRICING) : DEFAULT_PRICING
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M
  return Math.round((inputCost + outputCost) * 100) // Convert to cents
}

/**
 * Estimates cost in cents from total token count (approximate 3:1 input:output ratio).
 * Used when we only have aggregate token_usage without input/output breakdown.
 */
export function estimateCostFromTotal(totalTokens: number, modelId?: string): number {
  // Approximate: 75% input, 25% output (typical for code tasks)
  const inputTokens = Math.round(totalTokens * 0.75)
  const outputTokens = Math.round(totalTokens * 0.25)
  return estimateCostCents(inputTokens, outputTokens, modelId)
}

interface CostSummary {
  totalCostCents: number
  totalTokens: number
  sessionCount: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Cache hit rate as a percentage (0-100) */
  cacheHitRate: number
  byAgent: {
    agentType: string
    costCents: number
    tokens: number
    sessions: number
  }[]
}

interface BudgetStatus {
  /** Current estimated cost in cents */
  currentCostCents: number
  /** Configured daily budget in cents (0 = unlimited) */
  dailyBudgetCents: number
  /** Configured session budget in cents (0 = unlimited) */
  sessionBudgetCents: number
  /** Percent of daily budget used */
  dailyPercentUsed: number
  /** Whether daily budget warning threshold reached */
  dailyWarning: boolean
  /** Whether daily budget exceeded */
  dailyExceeded: boolean
}

/**
 * Cost tracking service — estimates USD costs from token usage
 * and enforces configurable budget limits.
 *
 * Events emitted:
 * - `budgetWarning`: { workspaceId, percentUsed, currentCostCents, budgetCents }
 * - `budgetExceeded`: { workspaceId, currentCostCents, budgetCents }
 */
class CostTrackerService extends EventEmitter {
  /**
   * Gets the estimated cost summary for a workspace.
   */
  getWorkspaceCostSummary(workspaceId: string): CostSummary {
    const summary = agentSessionRepository.getTokenSummary(workspaceId)
    const sessions = agentSessionRepository.findByWorkspace(workspaceId)

    let totalCostCents = 0
    const agentCosts = new Map<string, { costCents: number; tokens: number; sessions: number }>()

    for (const session of sessions) {
      // Use actual input/output breakdown when available (v37+), fallback to estimate for legacy sessions
      const cost =
        session.inputTokens > 0 || session.outputTokens > 0
          ? estimateCostCents(
              session.inputTokens,
              session.outputTokens,
              session.modelUsed ?? undefined
            )
          : estimateCostFromTotal(session.tokenUsage, session.modelUsed ?? undefined)
      totalCostCents += cost

      const existing = agentCosts.get(session.agentType) ?? { costCents: 0, tokens: 0, sessions: 0 }
      existing.costCents += cost
      existing.tokens += session.tokenUsage
      existing.sessions += 1
      agentCosts.set(session.agentType, existing)
    }

    // Compute cache hit rate from aggregated token summary
    const totalCacheTokens =
      summary.totalCacheReadTokens + summary.totalCacheCreationTokens + summary.totalInputTokens
    const cacheHitRate =
      totalCacheTokens > 0 ? (summary.totalCacheReadTokens / totalCacheTokens) * 100 : 0

    return {
      totalCostCents,
      totalTokens: summary.totalTokens,
      sessionCount: summary.sessionCount,
      cacheReadTokens: summary.totalCacheReadTokens,
      cacheCreationTokens: summary.totalCacheCreationTokens,
      cacheHitRate,
      byAgent: Array.from(agentCosts.entries()).map(([agentType, data]) => ({
        agentType,
        ...data
      }))
    }
  }

  /**
   * Gets the estimated cost for a single conversation.
   */
  getConversationCostCents(conversationId: string): number {
    const summary = agentSessionRepository.getConversationTokenSummary(conversationId)
    // Use actual breakdown when available (v37+), fallback to estimate for legacy data
    if (summary.totalInputTokens > 0 || summary.totalOutputTokens > 0) {
      return estimateCostCents(summary.totalInputTokens, summary.totalOutputTokens)
    }
    return estimateCostFromTotal(summary.totalTokens)
  }

  /**
   * Gets cost breakdown for all conversations in a workspace (single query, avoids N+1).
   */
  getWorkspaceConversationCosts(
    workspaceId: string
  ): { conversationId: string; costCents: number; totalTokens: number }[] {
    const db = getDatabase()
    const rows = db
      .prepare(
        `SELECT conversation_id,
                COALESCE(SUM(token_usage), 0) as total_tokens,
                COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                COALESCE(SUM(output_tokens), 0) as total_output_tokens
         FROM agent_sessions
         WHERE workspace_id = ? AND conversation_id IS NOT NULL
         GROUP BY conversation_id
         ORDER BY total_tokens DESC`
      )
      .all(workspaceId) as {
      conversation_id: string
      total_tokens: number
      total_input_tokens: number
      total_output_tokens: number
    }[]

    return rows.map((r) => ({
      conversationId: r.conversation_id,
      totalTokens: r.total_tokens,
      costCents:
        r.total_input_tokens > 0 || r.total_output_tokens > 0
          ? estimateCostCents(r.total_input_tokens, r.total_output_tokens)
          : estimateCostFromTotal(r.total_tokens)
    }))
  }

  /**
   * Checks budget status for a workspace and emits warnings if thresholds are exceeded.
   */
  checkBudget(workspaceId: string): BudgetStatus {
    const workspace = workspaceRepository.findAll().find((w) => w.id === workspaceId)
    const settings = workspace ? JSON.parse(workspace.settingsJson || '{}') : {}

    const dailyBudgetCents = (settings.dailyBudgetUsd ?? 0) * 100
    const sessionBudgetCents = (settings.sessionBudgetUsd ?? 0) * 100

    const costSummary = this.getWorkspaceCostSummary(workspaceId)
    const currentCostCents = costSummary.totalCostCents

    let dailyPercentUsed = 0
    let dailyWarning = false
    let dailyExceeded = false

    if (dailyBudgetCents > 0) {
      dailyPercentUsed = (currentCostCents / dailyBudgetCents) * 100

      if (dailyPercentUsed >= BUDGET_HARD_STOP_PERCENT) {
        dailyExceeded = true
        eventLoggerService.logBudgetExceeded({
          workspaceId,
          currentCostCents,
          budgetCents: dailyBudgetCents
        })
        this.emit('budgetExceeded', {
          workspaceId,
          currentCostCents,
          budgetCents: dailyBudgetCents
        })
        costLogger.warn(
          `Budget EXCEEDED for workspace ${workspaceId}: $${(currentCostCents / 100).toFixed(2)} / $${(dailyBudgetCents / 100).toFixed(2)}`
        )
      } else if (dailyPercentUsed >= BUDGET_WARNING_PERCENT) {
        dailyWarning = true
        eventLoggerService.logBudgetWarning({
          workspaceId,
          currentCostCents,
          budgetCents: dailyBudgetCents,
          percentUsed: dailyPercentUsed
        })
        this.emit('budgetWarning', {
          workspaceId,
          currentCostCents,
          budgetCents: dailyBudgetCents,
          percentUsed: dailyPercentUsed
        })
        costLogger.info(
          `Budget warning for workspace ${workspaceId}: ${dailyPercentUsed.toFixed(0)}% used`
        )
      }
    }

    return {
      currentCostCents,
      dailyBudgetCents,
      sessionBudgetCents,
      dailyPercentUsed,
      dailyWarning,
      dailyExceeded
    }
  }
}

export const costTrackerService = new CostTrackerService()
