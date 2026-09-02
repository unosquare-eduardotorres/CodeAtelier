/**
 * Pick the workflow transition that means "started" or "finished".
 *
 * Transition ids are per-project — "In Progress" is 21 on one workflow and 4 on
 * the next — so the only way to move a ticket is to read its transitions and
 * choose one. Choosing is the hard part: target names vary (Done / Closed /
 * Resolved / Ready for Release) and a non-English instance offers none of them.
 *
 * Jira Cloud gives a better signal than the name: `transitions[].to
 * .statusCategory.key` is one of `new` · `indeterminate` · `done`, whatever the
 * board calls its columns. That is matched first; the English names are the
 * fallback for responses that carry no category.
 *
 * Dependency-free on purpose — the renderer's "move to In Progress" checkbox and
 * the blueprint pipeline's write-back both import it, so the two cannot drift.
 */

import type { JiraTransition, JiraSyncIntent } from './jira.types'

/** Status category each intent lands in. */
const CATEGORY: Record<JiraSyncIntent, 'indeterminate' | 'done'> = {
  'in-progress': 'indeterminate',
  done: 'done'
}

/** English names that confirm a candidate, when Jira gives us one to read. */
const NAME_HINT: Record<JiraSyncIntent, RegExp> = {
  'in-progress': /in\s*progress|start/i,
  done: /\b(done|complete|resolve|closed?|finish|ship)/i
}

/**
 * Names that disqualify a candidate outright, even when the category matches.
 *
 * "Won't Do" and "Duplicate" are both `done` to Jira but neither means the work
 * was delivered, and closing a ticket as a duplicate on someone's board is not
 * something an automatic write gets to do. On the in-progress side "Blocked",
 * "In Review" and "Ready for QA" are all `indeterminate` — none of them means
 * "I have started this".
 */
const NEVER: Record<JiraSyncIntent, RegExp> = {
  'in-progress': /block|hold|wait|pend|review|qa|test|verif|approv|reject|cancel/i,
  done: /won'?t|duplicate|cancel|reject|abandon|obsolete|decline|invalid|revert/i
}

/** Both fields matter: workflows name the transition and the status differently. */
function labelOf(t: JiraTransition): string {
  return `${t.name} ${t.toStatus ?? ''}`
}

/**
 * The transition that moves an issue to `intent`, or null when the workflow
 * offers none.
 *
 * Null is a normal answer, not an error — plenty of workflows have no "In
 * Progress", and a caller must skip rather than guess. Guessing here means
 * moving someone's ticket into a state nobody asked for.
 */
export function findTransitionTo(
  transitions: readonly JiraTransition[],
  intent: JiraSyncIntent
): JiraTransition | null {
  const allowed = transitions.filter((t) => !NEVER[intent].test(labelOf(t)))
  const byCategory = allowed.filter((t) => t.toCategory === CATEGORY[intent])

  // Name match inside the category when we have both; across everything left
  // when Jira sent no categories at all (Server / DC).
  const pool = byCategory.length > 0 ? byCategory : allowed
  const named = pool.find((t) => NAME_HINT[intent].test(labelOf(t)))
  if (named) return named

  // No readable name — trust the category, which is language-independent. With
  // no category either there is nothing left to go on, so this returns null
  // rather than picking the first transition in the list.
  return byCategory[0] ?? null
}
