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

// ── Multi-signal complexity scoring ──────────────────────────────────
//
// Detects whether a user message describes a task complex enough
// to warrant auto-switching from Build to Plan mode.
//
// Uses a multi-signal scoring approach (no LLM call):
//  - Action scope signals: migration, refactor, architecture-level verbs
//  - Scale signals: "across", "entire", "all", multi-file/system refs
//  - Structural signals: message length, "from X to Y" patterns, tech names
//
// Returns true when 2+ signal categories fire — avoids false positives
// from a single keyword match.

// ── Category 1: High-scope action verbs (anywhere in message) ──
const SCOPE_ACTION_PATTERNS = [
  /\b(migrate|migration)\b/i,
  /\b(refactor|rewrite|overhaul|redesign|rearchitect)\b/i,
  /\b(port|porting)\b/i,
  /\b(replace|swap|switch)\b.*\b(with|to|for)\b/i,
  /\bcut\b.*\b(over|off)\b.*\b(to|from|onto)\b/i,
  /\b(transition|move)\b.*\b(to|from|onto)\b/i,
  /\b(set\s+up|stand\s+up|bootstrap)\b.*\b(pipeline|infrastructure|ci\/?cd|deployment)\b/i,
  /\b(implement|add\s+support\s+for|introduce)\b.*\b(sso|oauth|auth|i18n|internationali[sz]ation|multi.?tenant|real.?time)\b/i,
]

// ── Category 2: Scale / breadth indicators ──
const SCALE_PATTERNS = [
  /\b(across\s+the\s+(app|codebase|project|repo|system))\b/i,
  /\b(entire|whole|all\s+(of\s+)?(the\s+)?)\b.*\b(app|system|codebase|project|backend|frontend|stack)\b/i,
  /\b(frontend\s+and\s+backend|client\s+and\s+server|ui\s+and\s+api)\b/i,
  /\b(database|schema|api|authentication|authorization)\b.*\b(and)\b.*\b(database|schema|api|authentication|authorization)\b/i,
]

// ── Category 3: Structural complexity ──
function hasStructuralComplexity(text: string): boolean {
  const trimmed = text.trim()
  // Long messages (>300 chars) suggest multi-step thinking
  if (trimmed.length > 300) return true
  // "from X to Y" migration pattern
  if (/\bfrom\s+\S+\s+to\s+\S+/i.test(trimmed)) return true
  // Multiple technology names (2+)
  const techNames = trimmed.match(
    /\b(react|vue|angular|express|fastify|postgres|mysql|mongo|redis|supabase|firebase|azure|aws|gcp|docker|kubernetes|prisma|drizzle|graphql|rest|grpc)\b/gi
  )
  if (techNames && new Set(techNames.map((t) => t.toLowerCase())).size >= 2) return true
  return false
}

export function detectComplexTask(text: string): boolean {
  const trimmed = text.trim()
  let score = 0
  if (SCOPE_ACTION_PATTERNS.some((p) => p.test(trimmed))) score++
  if (SCALE_PATTERNS.some((p) => p.test(trimmed))) score++
  if (hasStructuralComplexity(trimmed)) score++
  // Require 2+ categories to fire — prevents false positives
  return score >= 2
}
