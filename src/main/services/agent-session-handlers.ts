/**
 * Pure-logic helpers extracted from AgentSessionService for testability.
 *
 * These functions are side-effect-free (no DB, no FS, no IPC) and handle:
 * - Plan payload parsing (raw → PlanDetectedEvent)
 * - Context enrichment formatting (reconstruction/summary → enriched message)
 */

import type { PlanDetectedEvent } from '../../shared/types'

/**
 * Parse a raw plan payload (from IPC bridge or control-actions) into a
 * validated PlanDetectedEvent. Handles both well-shaped objects and raw
 * JSON strings, with fallback to null for `structuredPlan` on malformed data.
 */
export function parsePlanPayload(payload: unknown, beforePlan: string): PlanDetectedEvent {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const obj =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  return {
    rawContent: raw,
    structuredPlan:
      (obj.structuredPlan as PlanDetectedEvent['structuredPlan']) ??
      // Direct StructuredPlan object (from SDK onPlan callback)
      (obj.type !== undefined && obj.phases !== undefined
        ? (payload as PlanDetectedEvent['structuredPlan'])
        : null),
    beforePlan,
    afterPlan: ''
  }
}

/**
 * Format context enrichment for local LLM messages.
 *
 * Two-tier strategy:
 * 1. S12: Full context reconstruction (if `reconstructedContext` provided)
 * 2. S6: Conversation summary fallback (if `summary` provided)
 * 3. Fallback: raw message unchanged
 *
 * Returns the enriched message string.
 */
export function formatContextEnrichment(params: {
  message: string
  reconstructedContext: string | null
  summary: string | null
}): { enrichedMessage: string; path: 'reconstructed' | 'summary' | 'raw' } {
  if (params.reconstructedContext) {
    return {
      enrichedMessage: `## Previous Context\n${params.reconstructedContext}\n\n## Current Request\n${params.message}`,
      path: 'reconstructed'
    }
  }
  if (params.summary) {
    return {
      enrichedMessage: `## Previous Context\n${params.summary}\n\n## Current Request\n${params.message}`,
      path: 'summary'
    }
  }
  return { enrichedMessage: params.message, path: 'raw' }
}
