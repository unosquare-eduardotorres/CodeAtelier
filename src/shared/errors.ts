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
