/**
 * Pure message formatters extracted from EventLoggerService for testability.
 *
 * Each formatter takes structured input and returns { eventType, message }
 * ready for the event logger's `log()` method.
 */

/**
 * Format a quality gate result into eventType + message.
 * eventType: `gate.{type}.{pass|fail}`
 * message:   `[PASSED|FAILED] {type}: {summary}`
 */
export function formatGateResultMessage(gate: {
  type: string
  passed: boolean
  summary: string
}): { eventType: string; message: string } {
  const status = gate.passed ? 'PASSED' : 'FAILED'
  return {
    eventType: `gate.${gate.type}.${gate.passed ? 'pass' : 'fail'}`,
    message: `[${status}] ${gate.type}: ${gate.summary}`
  }
}

/**
 * Format a budget warning message.
 * message: `Budget {pct}% used ($X.XX / $Y.YY)`
 */
export function formatBudgetWarningMessage(opts: {
  currentCostCents: number
  budgetCents: number
  percentUsed: number
}): { eventType: string; message: string } {
  return {
    eventType: 'budget.warning',
    message: `Budget ${opts.percentUsed.toFixed(0)}% used ($${(opts.currentCostCents / 100).toFixed(2)} / $${(opts.budgetCents / 100).toFixed(2)})`
  }
}

/**
 * Format a budget exceeded message.
 * message: `Budget exceeded: $X.XX > $Y.YY`
 */
export function formatBudgetExceededMessage(opts: {
  currentCostCents: number
  budgetCents: number
}): { eventType: string; message: string } {
  return {
    eventType: 'budget.exceeded',
    message: `Budget exceeded: $${(opts.currentCostCents / 100).toFixed(2)} > $${(opts.budgetCents / 100).toFixed(2)}`
  }
}

/**
 * Format a model escalation message.
 * message: `Escalated {agentId} from {fromModel} to {toModel}: {reason}`
 */
export function formatEscalationMessage(opts: {
  agentId: string
  fromModel: string
  toModel: string
  reason: string
}): { eventType: string; message: string } {
  return {
    eventType: 'escalation.model',
    message: `Escalated ${opts.agentId} from ${opts.fromModel} to ${opts.toModel}: ${opts.reason}`
  }
}

/**
 * Format an agent lifecycle message (started/completed/failed).
 */
export function formatAgentMessage(
  action: 'started' | 'completed' | 'failed',
  opts: { agentId: string; taskId?: string; error?: string }
): { eventType: string; message: string } {
  const taskLabel = opts.taskId ?? 'unknown'
  if (action === 'failed') {
    return {
      eventType: `agent.${action}`,
      message: `Specialist ${opts.agentId} failed task ${taskLabel}: ${opts.error ?? 'unknown error'}`
    }
  }
  return {
    eventType: `agent.${action}`,
    message: `Specialist ${opts.agentId} ${action} task ${taskLabel}`
  }
}

/**
 * Format a session lifecycle message (started/failed).
 */
export function formatSessionMessage(
  action: 'started' | 'failed',
  opts: { agentId: string; error?: string }
): { eventType: string; message: string } {
  if (action === 'failed') {
    return {
      eventType: 'session.failed',
      message: `Agent ${opts.agentId} session failed: ${opts.error ?? 'unknown error'}`
    }
  }
  return {
    eventType: 'session.started',
    message: `Agent ${opts.agentId} session started`
  }
}
