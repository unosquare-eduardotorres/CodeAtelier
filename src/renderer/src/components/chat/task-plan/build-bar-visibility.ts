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
 * Scope note: this now governs only the GoalCard's read-only/regenerate props,
 * NOT action-bar visibility — that is `derivePlanBarState` below. The two differ
 * on purpose: editing the goal of an already-actioned plan would desync it from
 * the build in flight, while re-clicking Build is exactly what we want to allow.
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

// ── Action bar state ───────────────────────────────────────────────
//
// The bar used to be rendered behind `!planLocked && !isStreaming`, so both
// operands failing produced *nothing on screen and no way forward*: an
// unfinalized turn leaves `isStreaming` stuck true, which also stops the
// `buildIdle` escape hatch from ever arming, so a phase left 'in_progress'
// locked the bar until the app was restarted.
//
// The fix is to make every situation a named state with a rendering. Clicking a
// button is explicitly NOT terminal — only a completed build is.

export type PlanBarState =
  | { kind: 'actionable' }
  /** The agent is mid-turn — buttons visible but disabled. */
  | { kind: 'working' }
  /** Blocked on a tool permission or a question — the user must answer first. */
  | { kind: 'awaiting_input' }
  /** A phase is genuinely running. */
  | { kind: 'building' }
  /** This plan was actioned; the action can be repeated. */
  | { kind: 'actioned'; action: string }
  /** The stream stopped responding (STALL-DETECT-03). */
  | { kind: 'stalled' }
  /** Terminal: the build completed or emitted its summary. */
  | { kind: 'done' }

export interface PlanBarStateInput {
  planAction: string | undefined | null
  execution: ExecutionLike | undefined | null
  /** chatStore.isStreaming — global, and stuck true for turns that never finalize. */
  isStreaming?: boolean
  /** 2s of genuine idle: an in-flight phase status past this point is stale. */
  buildIdle?: boolean
  /** chatStore.streamStalledConversationId matches this conversation. */
  stalled?: boolean
  /** A pending tool permission or pending questions are on screen. */
  awaitingInput?: boolean
  /** A build-summary block has landed for this build. */
  buildSummarySeen?: boolean
}

/**
 * Live reality outranks stale flags: `building`/`stalled`/`awaiting_input`/
 * `working` are evaluated before the terminal states, so a rehydrated record
 * can never claim "done" while the agent is visibly working.
 *
 * `done` is deliberately scoped to *this* plan (planAction 'build' + a
 * completed execution, or an observed build summary). The execution record is
 * per-conversation and outlives the build, so keying `done` off `completedAt`
 * alone would mark every subsequent plan in the conversation as finished.
 */
export function derivePlanBarState(input: PlanBarStateInput): PlanBarState {
  if (isBuildRunning(input.execution) && !input.buildIdle) return { kind: 'building' }
  if (input.stalled) return { kind: 'stalled' }
  if (input.awaitingInput) return { kind: 'awaiting_input' }
  if (input.isStreaming) return { kind: 'working' }
  if (input.buildSummarySeen) return { kind: 'done' }
  if (input.planAction === 'build' && input.execution?.completedAt) return { kind: 'done' }
  if (input.planAction) return { kind: 'actioned', action: input.planAction }
  return { kind: 'actionable' }
}
