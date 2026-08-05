/**
 * Shared error types for cross-cutting concerns.
 *
 * These errors carry structured metadata so callers can inspect them
 * programmatically rather than parsing error messages.
 */

/**
 * Thrown when a workspace's daily or per-session budget has been exceeded.
 * The agent execution pipeline catches this to surface a user-visible error
 * and end the turn cleanly rather than silently continuing to burn tokens.
 */
export class BudgetExceededError extends Error {
  readonly workspaceId: string
  readonly currentCostCents: number
  readonly budgetCents: number
  readonly scope: 'daily' | 'session'

  constructor(params: {
    workspaceId: string
    currentCostCents: number
    budgetCents: number
    scope: 'daily' | 'session'
  }) {
    const scopeLabel = params.scope === 'daily' ? 'Daily' : 'Session'
    super(
      `${scopeLabel} budget exceeded for workspace ${params.workspaceId}: ` +
        `$${(params.currentCostCents / 100).toFixed(2)} / $${(params.budgetCents / 100).toFixed(2)}`
    )
    this.name = 'BudgetExceededError'
    this.workspaceId = params.workspaceId
    this.currentCostCents = params.currentCostCents
    this.budgetCents = params.budgetCents
    this.scope = params.scope
  }
}

/**
 * Thrown when a Project Specialist build is attempted before the workspace's
 * knowledge bootstrap (Brain → Bootstrap Project Knowledge) has produced any
 * facts.
 *
 * Tailoring without ingested knowledge degrades to the template skeleton, which
 * previously looked identical to a real build in the UI. Failing loudly here is
 * the point: the user gets an actionable message instead of a generic persona.
 */
export class SpecialistIngestionRequiredError extends Error {
  readonly workspaceId: string

  constructor(workspaceId: string) {
    super(
      'Deep Ingestion required — run Brain → Bootstrap Project Knowledge before building this specialist.'
    )
    this.name = 'SpecialistIngestionRequiredError'
    this.workspaceId = workspaceId
  }
}
