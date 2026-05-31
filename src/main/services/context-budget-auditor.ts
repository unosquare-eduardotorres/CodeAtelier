/**
 * S9: Context Budget Auditor — pre-flight check before sending requests to local LLMs.
 *
 * Estimates context consumption BEFORE the SDK call to catch the insidious
 * "system prompt ate the whole window" bug early. Runs only for local LLM
 * providers where context is scarce (32K–262K).
 *
 * Token estimation uses chars / 3.5 (conservative for English + code).
 */

import type { ContextWindowTier } from './context-management'
import { chatAgentLogger } from '../logger'

const log = chatAgentLogger

// ── Types ──

export interface ContextBudget {
  /** Total context window size in tokens */
  contextWindow: number
  /** Estimated system prompt consumption (chars / 3.5) */
  estimatedSystemPromptTokens: number
  /** Estimated tool schema consumption (toolCount × 450) */
  estimatedToolSchemaTokens: number
  /** Reserved for model output (varies by tier) */
  reservedForOutput: number
  /** Remaining tokens available for conversation messages */
  availableForConversation: number
  /** Ratio of available / contextWindow — below 0.3 is critical */
  warningRatio: number
  /** Human-readable breakdown for diagnostic logging */
  breakdown: string
}

/** Output token reserves by tier — smaller tiers need proportionally more headroom */
const OUTPUT_RESERVES: Record<ContextWindowTier, number> = {
  small: 4_000, // 32K → 4K for output
  medium: 8_000, // 128K → 8K for output
  large: 16_000 // 262K → 16K for output
}

// ── Auditor ──

/**
 * Audit the context budget for a local LLM request.
 *
 * Call this from `buildSdkExecuteOptions()` before sending the request.
 * If `warningRatio < 0.3`, the system prompt + tools consume >70% of the
 * context window, leaving dangerously little room for the conversation.
 */
export function auditContextBudget(params: {
  systemPrompt: string
  toolCount: number
  contextWindow: number
  tier: ContextWindowTier
}): ContextBudget {
  const { systemPrompt, toolCount, contextWindow, tier } = params

  const estimatedSystemPromptTokens = Math.ceil(systemPrompt.length / 3.5)
  const estimatedToolSchemaTokens = toolCount * 450 // ~400-500 tokens per tool schema
  const reservedForOutput = OUTPUT_RESERVES[tier]

  const consumed = estimatedSystemPromptTokens + estimatedToolSchemaTokens + reservedForOutput
  const availableForConversation = Math.max(0, contextWindow - consumed)
  const warningRatio = contextWindow > 0 ? availableForConversation / contextWindow : 0

  const fmt = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n))

  const breakdown =
    `system=${fmt(estimatedSystemPromptTokens)} + tools(${toolCount})=${fmt(estimatedToolSchemaTokens)} ` +
    `+ outputReserve=${fmt(reservedForOutput)} = ${fmt(consumed)} consumed / ${fmt(contextWindow)} window ` +
    `→ ${fmt(availableForConversation)} available (${Math.round(warningRatio * 100)}%)`

  const budget: ContextBudget = {
    contextWindow,
    estimatedSystemPromptTokens,
    estimatedToolSchemaTokens,
    reservedForOutput,
    availableForConversation,
    warningRatio,
    breakdown
  }

  // Log diagnostics
  if (warningRatio < 0.2) {
    log.error(
      `[S9:context-budget-CRITICAL] ${breakdown} — less than 20% available! ` +
        `Consider trimming system prompt or reducing tool count.`
    )
  } else if (warningRatio < 0.3) {
    log.warn(`[S9:context-budget-WARNING] ${breakdown} — tight budget, may hit overflow`)
  } else {
    log.info(`[S9:context-budget] ${breakdown}`)
  }

  return budget
}

/**
 * Estimate the number of tools that will be mounted based on MCP config result.
 * Counts MCP tools from allowed tools list + SDK built-in tools not disallowed.
 */
export function estimateToolCount(params: {
  allowedTools?: string[]
  disallowedTools: string[]
  isLocalProvider: boolean
}): number {
  const { allowedTools, disallowedTools } = params

  // If we have an explicit allowed list, that's the tool count
  if (allowedTools) {
    return allowedTools.length
  }

  // SDK has ~11 built-in tools + whatever MCP tools are mounted
  const defaultBuiltinCount = 11
  const disallowedBuiltins = disallowedTools.filter((t) =>
    [
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Bash',
      'Glob',
      'Grep',
      'TodoRead',
      'TodoWrite',
      'NotebookRead',
      'NotebookEdit'
    ].includes(t)
  )
  return defaultBuiltinCount - disallowedBuiltins.length
}
