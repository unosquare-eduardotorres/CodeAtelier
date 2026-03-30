import log from 'electron-log/main'
import { eventRepository } from '../db/repositories/event.repository'
import type { EventCategory } from '../db/repositories/event.repository'
import type { QualityGateResult } from './abandonment-detector.service'

const eventLog = log.scope('EventLogger')

/**
 * Structured event logging service.
 *
 * All agent lifecycle events, quality gates, escalations, budget alerts,
 * and hook actions are logged to the events DB table for analysis and debugging.
 */
class EventLoggerService {
  private log(
    eventType: string,
    category: EventCategory,
    message: string,
    opts: {
      sessionId?: string
      conversationId?: string
      workspaceId?: string
      data?: Record<string, unknown>
      agentId?: string
      model?: string
    } = {}
  ): void {
    try {
      eventRepository.create({
        eventType,
        category,
        message,
        ...opts
      })
    } catch (err) {
      eventLog.error(`Failed to log event [${eventType}]:`, err)
    }
  }

  // ── Session Events ──

  logSessionStarted(opts: {
    sessionId?: string
    conversationId?: string
    workspaceId?: string
    agentId: string
    model?: string
  }): void {
    this.log('session.started', 'session', `Agent ${opts.agentId} session started`, opts)
  }

  logSessionCompleted(opts: {
    sessionId?: string
    conversationId?: string
    workspaceId?: string
    agentId: string
    tokenUsage?: number
    durationMs?: number
  }): void {
    this.log('session.completed', 'session', `Agent ${opts.agentId} session completed`, {
      ...opts,
      data: { tokenUsage: opts.tokenUsage, durationMs: opts.durationMs }
    })
  }

  logSessionFailed(opts: {
    sessionId?: string
    conversationId?: string
    workspaceId?: string
    agentId: string
    error: string
  }): void {
    this.log('session.failed', 'session', `Agent ${opts.agentId} session failed: ${opts.error}`, {
      ...opts,
      data: { error: opts.error }
    })
  }

  // ── Agent Events ──

  logAgentStarted(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId?: string
    model?: string
    complexityTier?: string
  }): void {
    this.log(
      'agent.started',
      'agent',
      `Specialist ${opts.agentId} started task ${opts.taskId ?? 'unknown'}`,
      {
        ...opts,
        data: { taskId: opts.taskId, complexityTier: opts.complexityTier }
      }
    )
  }

  logAgentCompleted(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId?: string
    tokenUsage?: number
  }): void {
    this.log(
      'agent.completed',
      'agent',
      `Specialist ${opts.agentId} completed task ${opts.taskId ?? 'unknown'}`,
      {
        ...opts,
        data: { taskId: opts.taskId, tokenUsage: opts.tokenUsage }
      }
    )
  }

  logAgentFailed(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId?: string
    error: string
    attempt?: number
  }): void {
    this.log(
      'agent.failed',
      'agent',
      `Specialist ${opts.agentId} failed task ${opts.taskId ?? 'unknown'}: ${opts.error}`,
      { ...opts, data: { taskId: opts.taskId, error: opts.error, attempt: opts.attempt } }
    )
  }

  // ── Escalation Events ──

  logModelEscalation(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId: string
    fromModel: string
    toModel: string
    reason: string
    attempt: number
  }): void {
    this.log(
      'escalation.model',
      'escalation',
      `Escalated ${opts.agentId} from ${opts.fromModel} to ${opts.toModel}: ${opts.reason}`,
      {
        ...opts,
        data: {
          taskId: opts.taskId,
          fromModel: opts.fromModel,
          toModel: opts.toModel,
          reason: opts.reason,
          attempt: opts.attempt
        }
      }
    )
  }

  // ── Quality Gate Events ──

  logGateResult(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId: string
    gate: QualityGateResult
  }): void {
    const status = opts.gate.passed ? 'PASSED' : 'FAILED'
    this.log(
      `gate.${opts.gate.type}.${opts.gate.passed ? 'pass' : 'fail'}`,
      'gate',
      `[${status}] ${opts.gate.type}: ${opts.gate.summary}`,
      {
        ...opts,
        data: {
          taskId: opts.taskId,
          gateType: opts.gate.type,
          passed: opts.gate.passed,
          summary: opts.gate.summary
        }
      }
    )
  }

  // ── Abandonment Events ──

  logAbandonmentDetected(opts: {
    conversationId?: string
    workspaceId?: string
    agentId: string
    taskId: string
    pattern: string
    context?: string
  }): void {
    this.log(
      'abandonment.detected',
      'abandonment',
      `Specialist ${opts.agentId} may have abandoned task ${opts.taskId}: "${opts.pattern}"`,
      {
        ...opts,
        data: { taskId: opts.taskId, pattern: opts.pattern, context: opts.context }
      }
    )
  }

  // ── Checkpoint Events ──

  logCheckpointCreated(opts: {
    conversationId: string
    workspaceId?: string
    checkpointId: string
    label: string
  }): void {
    this.log('checkpoint.created', 'checkpoint', `Checkpoint "${opts.label}" created`, {
      ...opts,
      data: { checkpointId: opts.checkpointId, label: opts.label }
    })
  }

  logCheckpointRestored(opts: {
    conversationId: string
    workspaceId?: string
    checkpointId: string
    label: string
  }): void {
    this.log('checkpoint.restored', 'checkpoint', `Restored checkpoint "${opts.label}"`, {
      ...opts,
      data: { checkpointId: opts.checkpointId, label: opts.label }
    })
  }

  // ── Hook Events ──

  logHookBlocked(opts: {
    conversationId?: string
    workspaceId?: string
    agentId?: string
    hookType: 'pre-tool-use' | 'post-tool-use'
    toolName: string
    reason: string
  }): void {
    this.log(
      `hook.${opts.hookType}.blocked`,
      'hook',
      `Hook blocked ${opts.toolName}: ${opts.reason}`,
      { ...opts, data: { hookType: opts.hookType, toolName: opts.toolName, reason: opts.reason } }
    )
  }

  // ── Budget Events ──

  logBudgetWarning(opts: {
    conversationId?: string
    workspaceId?: string
    currentCostCents: number
    budgetCents: number
    percentUsed: number
  }): void {
    this.log(
      'budget.warning',
      'budget',
      `Budget ${opts.percentUsed.toFixed(0)}% used ($${(opts.currentCostCents / 100).toFixed(2)} / $${(opts.budgetCents / 100).toFixed(2)})`,
      {
        ...opts,
        data: {
          currentCostCents: opts.currentCostCents,
          budgetCents: opts.budgetCents,
          percentUsed: opts.percentUsed
        }
      }
    )
  }

  logBudgetExceeded(opts: {
    conversationId?: string
    workspaceId?: string
    currentCostCents: number
    budgetCents: number
  }): void {
    this.log(
      'budget.exceeded',
      'budget',
      `Budget exceeded: $${(opts.currentCostCents / 100).toFixed(2)} > $${(opts.budgetCents / 100).toFixed(2)}`,
      {
        ...opts,
        data: {
          currentCostCents: opts.currentCostCents,
          budgetCents: opts.budgetCents
        }
      }
    )
  }

  // ── Decomposition / Orchestrator Events ──

  logDecompositionStarted(opts: {
    conversationId: string
    workspaceId?: string
    summary: string
    specialists: string[]
  }): void {
    this.log(
      'decomposition.started',
      'agent',
      `Decomposing task for ${opts.specialists.length} specialist(s): ${opts.summary.substring(0, 120)}`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          summary: opts.summary,
          specialists: opts.specialists
        }
      }
    )
  }

  logDecompositionCompleted(opts: {
    conversationId: string
    workspaceId?: string
    taskCount: number
    tasks: { id: string; specialist: string; model?: string }[]
  }): void {
    this.log(
      'decomposition.completed',
      'agent',
      `Decomposition produced ${opts.taskCount} task(s)`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          taskCount: opts.taskCount,
          tasks: opts.tasks
        }
      }
    )
  }

  logDecompositionFailed(opts: {
    conversationId: string
    workspaceId?: string
    error: string
    fallback: 'legacy' | 'abort' | 'none'
  }): void {
    this.log(
      'decomposition.failed',
      'error',
      `Decomposition failed: ${opts.error} — fallback: ${opts.fallback}`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          error: opts.error,
          fallback: opts.fallback
        }
      }
    )
  }

  logHandoffDetected(opts: {
    conversationId: string
    workspaceId?: string
    summary: string
    specialists: string[]
    mode?: string
  }): void {
    this.log(
      'handoff.detected',
      'agent',
      `Handoff detected: ${opts.summary.substring(0, 120)}`,
      {
        ...opts,
        agentId: 'generalist',
        data: {
          summary: opts.summary,
          specialists: opts.specialists,
          mode: opts.mode
        }
      }
    )
  }

  logPlanExecutionStarted(opts: {
    conversationId: string
    workspaceId?: string
    strategy: string
    taskCount: number
  }): void {
    this.log(
      'plan.execution.started',
      'agent',
      `Plan execution started: ${opts.strategy}, ${opts.taskCount} task(s)`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          strategy: opts.strategy,
          taskCount: opts.taskCount
        }
      }
    )
  }

  logPlanExecutionCompleted(opts: {
    conversationId: string
    workspaceId?: string
    strategy: string
    taskCount: number
  }): void {
    this.log(
      'plan.execution.completed',
      'agent',
      `Plan execution completed: ${opts.strategy}, ${opts.taskCount} task(s)`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          strategy: opts.strategy,
          taskCount: opts.taskCount
        }
      }
    )
  }

  logPlanExecutionFailed(opts: {
    conversationId: string
    workspaceId?: string
    strategy: string
    error: string
  }): void {
    this.log(
      'plan.execution.failed',
      'error',
      `Plan execution failed (${opts.strategy}): ${opts.error}`,
      {
        ...opts,
        agentId: 'orchestrator',
        data: {
          strategy: opts.strategy,
          error: opts.error
        }
      }
    )
  }

  // ── Tool Call Events ──

  logAgentToolCall(opts: {
    agentId: string
    conversationId?: string
    toolName: string
    toolCallNumber: number
  }): void {
    this.log(
      'agent.tool_call',
      'agent',
      `${opts.agentId} → ${opts.toolName} (call #${opts.toolCallNumber})`,
      {
        conversationId: opts.conversationId,
        agentId: opts.agentId,
        data: {
          toolName: opts.toolName,
          toolCallNumber: opts.toolCallNumber
        }
      }
    )
  }

  // ── Error Events ──

  logAgentTimeout(opts: {
    agentId: string
    conversationId?: string
    elapsedMs: number
    toolCallCount: number
  }): void {
    this.log(
      'agent.timeout',
      'error',
      `${opts.agentId} timed out after ${Math.round(opts.elapsedMs / 1000)}s (${opts.toolCallCount} tool calls)`,
      {
        conversationId: opts.conversationId,
        agentId: opts.agentId,
        data: {
          elapsedMs: opts.elapsedMs,
          toolCallCount: opts.toolCallCount
        }
      }
    )
  }

  logCircuitBreakerTripped(opts: {
    conversationId?: string
    workspaceId?: string
    failures: number
  }): void {
    this.log(
      'error.circuit_breaker',
      'error',
      `Circuit breaker tripped after ${opts.failures} consecutive failures`,
      { ...opts, data: { failures: opts.failures } }
    )
  }

  // ── Investigation Pipeline ──

  logInvestigationReportDetected(opts: {
    conversationId?: string
    agentId: string
    taskId: string
    impact?: string
    filesAffected?: number
  }): void {
    this.log(
      'investigation.report_detected',
      'agent',
      `Investigation report detected from ${opts.agentId}/${opts.taskId}`,
      {
        conversationId: opts.conversationId,
        agentId: opts.agentId,
        data: { taskId: opts.taskId, impact: opts.impact, filesAffected: opts.filesAffected }
      }
    )
  }

  logInvestigationReportMissing(opts: {
    conversationId?: string
    agentId: string
    taskId: string
    outputLength: number
  }): void {
    this.log(
      'investigation.report_missing',
      'agent',
      `Investigation task ${opts.agentId}/${opts.taskId} completed without structured report`,
      {
        conversationId: opts.conversationId,
        agentId: opts.agentId,
        data: { taskId: opts.taskId, outputLength: opts.outputLength }
      }
    )
  }

  // ── Utility ──

  /** Prune events older than N days */
  prune(days: number = 30): number {
    const count = eventRepository.pruneOlderThan(days)
    if (count > 0) {
      eventLog.info(`Pruned ${count} events older than ${days} days`)
    }
    return count
  }
}

export const eventLoggerService = new EventLoggerService()
