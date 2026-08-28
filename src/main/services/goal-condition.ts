/**
 * Shared sanitisation for `/goal` completion conditions.
 *
 * Two very different deliveries share one condition string:
 *
 *  - Claude CLI: `/goal <condition>` queued over stdin, which the CLI *enforces*
 *    with a Haiku-based stop-hook evaluator.
 *  - OpenCode (GLM, local LLMs): no such mechanism exists, so the condition is
 *    injected into the system prompt as a `## Completion Goal` section. This is
 *    ADVISORY — the model is told what "done" means, but nothing blocks it from
 *    stopping early.
 *
 * Both paths sanitise identically so a condition does not behave differently
 * depending on which provider the workspace happens to be on.
 */

/** Hard cap on a condition — long conditions crowd out the rest of the prompt. */
export const GOAL_MAX_CHARS = 4_000

/** Words that, when a goal condition starts with them, collide with /goal subcommands. */
export const GOAL_CLEAR_ALIASES = /^(clear|stop|off|reset|none|cancel)\b/i

/**
 * Collapse whitespace, trim, and cap a raw goal condition.
 * Returns `null` for empty/whitespace-only input.
 */
export function sanitizeGoalCondition(goal: string): string | null {
  const sanitized = goal.replace(/\s+/g, ' ').trim()
  if (!sanitized) return null
  return sanitized.length > GOAL_MAX_CHARS ? sanitized.slice(0, GOAL_MAX_CHARS) : sanitized
}

/**
 * Build the `## Completion Goal` system-prompt section, or `null` when there is no
 * usable condition. Used by every backend — the CLI adds native enforcement on top.
 */
export function buildGoalPromptSection(goal: string): string | null {
  const condition = sanitizeGoalCondition(goal)
  if (!condition) return null
  return (
    '\n\n## Completion Goal\n\n' +
    'Work autonomously until the following condition is met, then emit the completion block:\n\n' +
    condition
  )
}

/**
 * Whether a backend can *enforce* a goal, or only advise on it.
 *
 * Only the Claude CLI has the stop-hook evaluator. Telling a GLM user their goal is
 * being enforced when it is not is how "/goal accepted but never enforced" happens.
 */
export function goalEnforcementFor(backend: 'cli' | 'opencode'): 'enforced' | 'advisory' {
  return backend === 'cli' ? 'enforced' : 'advisory'
}
