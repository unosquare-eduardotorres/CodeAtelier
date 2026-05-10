/**
 * Detects whether a user message is an investigation/review intent
 * that should auto-switch from Build to Plan mode.
 *
 * Only matches prompts that clearly request read-only analysis,
 * not build/write actions that happen to use similar verbs.
 */
const PLAN_INTENT_PATTERNS = [
  /^(investigate|investigation)\b/i,
  /^take a look\b/i,
  /^(check|review|audit|analyze|analyse|examine|inspect)\b/i,
  /^generate (a )?plan\b/i,
  /^(create|make|draft) (a )?plan\b/i,
  /^(look into|look at|dig into)\b/i,
  /^(explain|understand|explore)\b/i,
  /^what('s| is) (happening|wrong|going on)\b/i,
  /^(can you )?(check|review|investigate|look)\b/i,
  /^(find out|figure out)\b/i
]

export function detectPlanIntent(text: string): boolean {
  const trimmed = text.trim()
  return PLAN_INTENT_PATTERNS.some((pattern) => pattern.test(trimmed))
}
