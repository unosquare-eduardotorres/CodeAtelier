import log from 'electron-log/main'
import type { AgentRole } from '../../shared/types'
import { usageLogRepository } from '../db/repositories'
import { estimateCostCents } from './cost-tracker.service'

const usageLogger = log.scope('UsageTracker')

/**
 * Maps a session-flow agent role to its unified usage_log `feature` bucket.
 * Session adapters self-identify via `adapter.role`; this collapses related
 * roles (e.g. all MPA/council variants) into one feature for the breakdown.
 */
export function featureForAgentRole(role: AgentRole): string {
  switch (role) {
    case 'da-vinci':
    case 'project-specialist':
      return 'chat'
    case 'grill':
      return 'grill'
    case 'audit':
      return 'audit'
    case 'mpa-planner':
    case 'mpa-builder':
    case 'mpa-verifier':
      return 'mpa'
    case 'council-member':
    case 'council-chairman':
      return 'council'
    default:
      return role
  }
}

/** Token counts for a single LLM consumption event. */
export interface UsageTokens {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}

export interface RecordUsageInput {
  /** Feature that consumed the tokens (chat|grill|council|mpa|audit|condense|...). */
  feature: string
  /** adapter.agentId for session flows; otherwise omit. */
  agentType?: string | null
  /** ACTUAL resolved model id. */
  model?: string | null
  workspaceId?: string | null
  conversationId?: string | null
  sessionId?: string | null
  turnNumber?: number | null
  tokens: UsageTokens
}

/**
 * Single recorder for ALL LLM token consumption. Every feature (session flows,
 * recovery nudges, and one-shot claude calls) funnels through here so the
 * unified `usage_log` table reflects the complete picture.
 *
 * Logging must NEVER break a feature — all failures are swallowed and logged.
 */
class UsageTrackerService {
  recordUsage(input: RecordUsageInput): void {
    try {
      const inputTokens = input.tokens.input ?? 0
      const outputTokens = input.tokens.output ?? 0
      const cacheReadTokens = input.tokens.cacheRead ?? 0
      const cacheCreationTokens = input.tokens.cacheCreation ?? 0

      const costCents = estimateCostCents(inputTokens, outputTokens, input.model ?? undefined)

      usageLogRepository.record({
        feature: input.feature,
        agentType: input.agentType ?? null,
        model: input.model ?? null,
        workspaceId: input.workspaceId ?? null,
        conversationId: input.conversationId ?? null,
        sessionId: input.sessionId ?? null,
        turnNumber: input.turnNumber ?? null,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costCents
      })
    } catch (err) {
      usageLogger.warn(`Failed to record usage for feature "${input.feature}":`, err)
    }
  }
}

export const usageTrackerService = new UsageTrackerService()
