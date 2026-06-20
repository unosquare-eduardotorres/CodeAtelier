/**
 * Pure-logic functions extracted from grill.ipc.ts for testability.
 *
 * No Electron, no I/O, no service references.
 */

import type { LLMProvider, StructuredPlan } from '../../shared/types'

// ── LLM Provider Resolution ──────────────────────────────────────────────────

/**
 * Resolve the LLM provider from the priority chain:
 *   explicit selection → workspace setting → default 'claude'.
 */
export function resolveLlmProvider(
  explicitProvider: LLMProvider | undefined,
  workspaceSetting: string | undefined
): LLMProvider {
  return explicitProvider ?? (workspaceSetting as LLMProvider) ?? 'claude'
}

// ── Condensation Guard ───────────────────────────────────────────────────────

const CONDENSATION_THRESHOLD = 1000

/**
 * Determine whether requirement text should be sent for condensation.
 * Returns false (skip) if text is empty/null or below the threshold.
 */
export function shouldCondenseRequirement(text: string | null | undefined): boolean {
  if (!text) return false
  return text.length >= CONDENSATION_THRESHOLD
}

// ── Plan Card Formatting ─────────────────────────────────────────────────────

/**
 * Format a structured plan as a Markdown message with a ```plan code fence.
 * Used by grill:seedPlanCard to insert a plan card into a conversation.
 */
export function formatPlanAsCardMessage(structured: StructuredPlan, leadIn: string): string {
  return `${leadIn}\n\n\`\`\`plan\n${JSON.stringify(structured)}\n\`\`\``
}
