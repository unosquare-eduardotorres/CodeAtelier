/**
 * Investigation keyword detection — single source of truth.
 * Used by: specialist pool execution limits (more turns/tools for investigation tasks).
 */
const INVESTIGATION_KEYWORDS = [
  'investigation report',
  'investigate',
  'diagnose',
  'produce a structured investigation'
]

/**
 * Detects whether a text string indicates investigation/plan intent
 * rather than implementation/build intent.
 */
export function isInvestigationIntent(text: string): boolean {
  const lower = text.toLowerCase()
  return INVESTIGATION_KEYWORDS.some((kw) => lower.includes(kw))
}
