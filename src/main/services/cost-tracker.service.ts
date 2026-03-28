import log from 'electron-log/main'
import { EventEmitter } from 'node:events'
import { agentSessionRepository, workspaceRepository } from '../db/repositories'
import { eventLoggerService } from './event-logger.service'

const costLogger = log.scope('CostTracker')

/**
 * Model pricing table — $/1M tokens for input and output.
 * Based on Claude pricing as of March 2026.
 * Updated model IDs should be added here as new models are released.
 */
export const MODEL_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  // Sonnet 4
  'claude-sonnet-4-20250514': { inputPer1M: 3.0, outputPer1M: 15.0 },
  // Opus 4
  'claude-opus-4-20250514': { inputPer1M: 15.0, outputPer1M: 75.0 },
  // Sonnet 3.5 (legacy, may still appear in older sessions)
  'claude-3-5-sonnet-20241022': { inputPer1M: 3.0, outputPer1M: 15.0 },
  // Haiku 3.5 (legacy)
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

export interface CostSummary {
  totalCostCents: number
  totalTokens: number
  sessionCount: number
  byAgent: {
    agentType: string
    costCents: number
    tokens: number
    sessions: number
  }[]
}

export interface BudgetStatus {
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
      const cost = estimateCostFromTotal(session.tokenUsage, session.modelUsed ?? undefined)
      totalCostCents += cost

      const existing = agentCosts.get(session.agentType) ?? { costCents: 0, tokens: 0, sessions: 0 }
      existing.costCents += cost
      existing.tokens += session.tokenUsage
      existing.sessions += 1
      agentCosts.set(session.agentType, existing)
    }

    return {
      totalCostCents,
      totalTokens: summary.totalTokens,
      sessionCount: summary.sessionCount,
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
    // Use rough estimate since we don't have per-session model info easily here
    return estimateCostFromTotal(summary.totalTokens)
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
