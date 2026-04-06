/**
 * Merged investigation keyword detection — single source of truth.
 * Used by: handoff mode resolution, decompose() description rewriting,
 * specialist pool execution limits.
 */
const INVESTIGATION_KEYWORDS = [
  // From specialist-pool.service.ts
  'investigation report',
  'investigate',
  'analyze',
  'diagnose',
  'audit',
  'review',
  // From generalist.service.ts regex (partial-match equivalents)
  'explain',
  'what does',
  'how does'
]

/**
 * Detects whether a text string indicates investigation/plan intent
 * rather than implementation/build intent.
 */
export function isInvestigationIntent(text: string): boolean {
  const lower = text.toLowerCase()
  return INVESTIGATION_KEYWORDS.some((kw) => lower.includes(kw))
}
