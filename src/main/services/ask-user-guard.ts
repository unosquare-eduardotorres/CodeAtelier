/**
 * Structural guard for the `ask_user` control tool.
 *
 * Clarifying questions must be asked BEFORE a plan is emitted, never after.
 * `ask_user` blocks the agent turn, so a question raised after `emit_plan`
 * would stack a question card underneath the plan card — exactly the broken UX
 * we want to prevent. When a plan has already been emitted this turn, the
 * blocked `ask_user` promise is resolved with this corrective message instead
 * of surfacing a question.
 *
 * Pure + dependency-free so it is unit-testable in isolation.
 */
export const ASK_USER_AFTER_PLAN_MESSAGE =
  'A plan was already emitted this turn. Ask clarifying questions BEFORE emit_plan, never after. ' +
  'Do not ask now — end your turn; the user will use Refine if they want changes.'

/**
 * Returns the corrective message when `ask_user` fires after `emit_plan` this
 * turn (the question should be rejected), or `null` when the question is allowed
 * to surface normally (ask-then-plan, the correct order).
 */
export function evaluateAskUserGuard(planEmittedThisTurn: boolean): string | null {
  return planEmittedThisTurn ? ASK_USER_AFTER_PLAN_MESSAGE : null
}
