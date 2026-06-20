import type { MpaPlanArtifact } from '../../shared/mpa-types'

/**
 * Build the /goal completion condition for the Planner phase.
 * The CLI evaluates this condition to decide when the phase is done.
 */
export function buildPlannerGoalCondition(goal: string): string {
  return [
    `A comprehensive implementation plan is produced for: "${goal.slice(0, 150)}"`,
    'The plan is emitted as a JSON code block tagged goal-plan',
    'The JSON has an items array where each item has id, title, description, files, scope, and dependsOn',
    'At least 3 codebase files were investigated before producing the plan'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the Builder phase.
 */
export function buildBuilderGoalCondition(plan: MpaPlanArtifact): string {
  const itemIds = plan.items.map((i) => i.id).join(', ')
  return [
    `All plan items (${itemIds}) are fully implemented`,
    'No TODO or placeholder implementations in new code',
    'Tests written for items with includesTests: true',
    'All tests pass when run via the project test command',
    'ESLint check passes with zero errors on all changed files'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the Verifier phase.
 */
export function buildVerifierGoalCondition(plan: MpaPlanArtifact): string {
  return [
    `All ${plan.items.length} plan items verified against the codebase`,
    'Each item has a goal-verify-item block with status',
    'A final goal-verify-report JSON block is produced',
    'The project test command was run and results included',
    'ESLint check was run on changed files and results included'
  ].join('. ')
}
