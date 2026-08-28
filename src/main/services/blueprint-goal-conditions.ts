/**
 * Blueprint Goal Conditions — /goal completion conditions for all blueprint phases.
 *
 * Following the mpa-goal-conditions.ts pattern: pure functions that build
 * goal condition strings delivered via /goal stdin command (goalMode: enforce).
 */

/**
 * Build the /goal completion condition for the SPECIFY phase.
 * The CLI evaluates this condition to decide when the phase is done.
 */
export function buildSpecifyGoalCondition(title: string): string {
  return [
    `A comprehensive specification is produced for: "${title.slice(0, 150)}"`,
    'The spec is emitted as a fenced code block tagged blueprint-phase-complete',
    'The JSON has phase: "specify" and status: "complete"',
    'At least 2 user stories with acceptance scenarios are defined',
    'Requirements have unique IDs (FR-xxx) and use MUST/SHOULD/MAY language'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the CLARIFY phase.
 */
export function buildClarifyGoalCondition(): string {
  return [
    'All identified specification gaps have been addressed through Q&A',
    'The completion block is emitted as blueprint-phase-complete with phase: "clarify"',
    'The coverage summary shows resolved count >= outstanding count'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the PLAN phase.
 */
export function buildPlanGoalCondition(title: string): string {
  return [
    `A detailed implementation plan is produced for: "${title.slice(0, 150)}"`,
    'The plan is emitted as a fenced code block tagged blueprint-plan',
    'The plan contains at least 2 plan items with unique IDs (P1, P2, etc.)',
    'Each item has files, scope, and dependency information',
    'A blueprint-phase-complete block is emitted with phase: "plan" and status: "complete"',
    'The mustHaves section includes truths, artifacts, and keyLinks'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the TASKS phase.
 */
export function buildTasksGoalCondition(title: string): string {
  return [
    `Implementation tasks are decomposed from the plan for: "${title.slice(0, 150)}"`,
    'Tasks are emitted as a fenced code block tagged blueprint-tasks',
    'Each task has a taskId (T001 format), description, files array, and wave assignment',
    'Wave dependencies are acyclic and same-wave tasks have no file overlap',
    'A blueprint-phase-complete block is emitted with phase: "tasks" and status: "complete"'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the REVIEW phase.
 */
export function buildReviewGoalCondition(title: string): string {
  return [
    `Cross-artifact review is completed for: "${title.slice(0, 150)}"`,
    'Coverage analysis traces spec requirements → plan items → tasks',
    'File paths are validated against actual codebase structure',
    'Findings are classified by severity (critical/high/medium/low)',
    'A blueprint-phase-complete block is emitted with phase: "review", status: "complete", findings counts, and recommendation'
  ].join('. ')
}

/**
 * Build the /goal completion condition for a single BUILD task.
 * Unlike other goal conditions which are per-phase, BUILD goals are per-task
 * because each task gets its own agent session.
 */
export function buildBuildGoalCondition(taskId: string, description: string): string {
  return [
    `Task ${taskId} is fully implemented: "${description.slice(0, 150)}"`,
    'All files listed in the task exist with correct content',
    'No placeholder or stub code is left behind',
    'Changes are staged individually (never git add .)',
    'A blueprint-phase-complete block is emitted with phase: "build", status: "complete"'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the VERIFY phase.
 * Adversarial verification — prove implementation matches spec.
 */
export function buildVerifyGoalCondition(title: string): string {
  return [
    `Adversarial verification is complete for: "${title.slice(0, 150)}"`,
    'All artifacts are verified using the 4-level methodology (EXISTS → SUBSTANTIVE → WIRED → DATA FLOWING)',
    'Key links from the plan are traced and validated',
    'Anti-pattern scan is complete (TODO/FIXME/empty bodies/hardcoded data)',
    'Each spec requirement is traced to implemented code',
    'Human verification items are listed if applicable',
    'A blueprint-phase-complete block is emitted with phase: "verify", overallStatus, and recommendation'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the CODE-REVIEW phase (M7.6).
 * Adversarial external review of the whole-feature diff — findings resolved
 * or ledgered, never silently dropped.
 */
export function buildCodeReviewGoalCondition(title: string): string {
  return [
    `Adversarial review of the complete feature diff is completed for: "${title.slice(0, 150)}"`,
    'Every finding names a file, a severity (critical/high/medium/low), and a one-line summary',
    'Critical and high findings include a concrete suggested fix',
    'A blueprint-phase-complete block is emitted with phase: "code-review", status: "complete", a findings array, and a verdict (approve / fix_required / concerns_noted)'
  ].join('. ')
}

/**
 * Build the /goal completion condition for the post-verify LEAD-REVIEW pass
 * (M6.1). The lead sees the whole diff plus the verify report and judges the
 * cross-task failure modes the per-task gates structurally cannot: spec drift,
 * test gaming, and whole-feature correctness.
 */
