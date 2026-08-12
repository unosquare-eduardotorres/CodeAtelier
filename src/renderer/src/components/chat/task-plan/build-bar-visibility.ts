/**
 * Visibility rules for the plan BuildActionBar ("Build Now" / Refine / Council /
 * Save as Idea).
 *
 * Extracted from ChatExecutionPanel so the rule can be tested without a
 * renderer — the conditions are subtle and each one exists because of a
 * specific failure:
 *
 *  - Gating on `activeMode === 'plan'` hid the bar in build mode even though the
 *    Plan tab itself stays visible there.
 *  - Gating on the mere existence of an execution record permanently hid the bar
 *    for every subsequent plan in a conversation: the record is
 *    per-conversation, outlives the build, and chat.store re-creates it on
 *    conversation load from persisted phase progress.
 *  - Gating on `completedAt` alone is not enough, because it is only set by the
 *    live IPC completion event and is therefore always absent on a hydrated
 *    record.
 *
 * Run: tsx src/renderer/src/components/chat/task-plan/__tests__/build-bar-visibility.test.ts
 */

/** Minimal shape needed from PlanExecution — keeps this module store-agnostic. */
export interface ExecutionLike {
  completedAt?: number
  phases: Array<{ status: string }>
}

/** Phase statuses that mean the agent is actively working the plan right now. */
const RUNNING_PHASE_STATUSES = new Set(['started', 'in_progress'])

/**
 * Is a build actively running for this conversation?
 *
 * A finished-and-rehydrated build reads as NOT running: none of its phases are
 * in a running state, even though `completedAt` is missing.
 */
export function isBuildRunning(execution: ExecutionLike | undefined | null): boolean {
  if (!execution) return false
  if (execution.completedAt) return false
  return execution.phases.some((p) => RUNNING_PHASE_STATUSES.has(p.status))
}

/**
 * Should the plan be treated as already actioned — i.e. the action bar hidden
 * and the goal card read-only?
 *
 * `planAction` is persisted per message (messages.plan_action), so it survives a
 * reload and is scoped to the specific plan on screen. `isBuildRunning` covers
 * the live build, including the 50-200ms gaps where `isStreaming` drops between
 * phases and a mid-build `emit_plan` has replaced the latest plan message.
 *
 * `buildIdle` is what stops `isBuildRunning` from locking forever: models often
 * never emit the final `emit_phase_progress`, so a phase stays 'in_progress' and
 * `completedAt` is never set — without this the bar was hidden for every plan
 * after the first build in a conversation.
 */
export function isPlanLocked(input: {
  planAction: string | undefined | null
  execution: ExecutionLike | undefined | null
  /** True once the conversation has been idle long enough that an in-flight
   *  phase status can only be stale — a build that ended without closing it. */
  buildIdle?: boolean
}): boolean {
  if (input.planAction) return true
  if (input.buildIdle) return false
  return isBuildRunning(input.execution)
}
