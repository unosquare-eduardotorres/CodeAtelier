/**
 * Structured logging helpers for specialist execution.
 *
 * Provides consistent JSON-structured log fields for key specialist lifecycle events.
 * Wraps electron-log scoped loggers with a typed interface that ensures every log
 * entry includes standardized fields (taskId, agentId, model, etc.) for log aggregation.
 *
 * Usage:
 *   const slog = createStructuredLogger(scopedLogger)
 *   slog.specialistStarted({ taskId, agentId, model, mode, cwd })
 *   slog.specialistCompleted({ taskId, agentId, durationMs, tokenUsage })
 */

import type { LogFunctions } from 'electron-log'

// ── Structured Field Types ──

export interface SpecialistLogFields {
  /** Task ID for correlation */
  taskId: string
  /** Specialist agent ID */
  agentId: string
  /** Model tier used (sonnet, opus, haiku) */
  model?: string
  /** Conversation mode */
  mode?: string
  /** Working directory */
  cwd?: string
  /** Execution attempt number */
  attempt?: number
  /** Duration in milliseconds */
  durationMs?: number
  /** Token usage breakdown */
  tokenUsage?: {
    input: number
    output: number
    cacheRead?: number
    cacheCreation?: number
    total: number
  }
  /** Error details */
  error?: string
  /** Additional context */
  [key: string]: unknown
}

interface StructuredLogger {
  /** Log specialist execution start */
  specialistStarted(fields: SpecialistLogFields): void
  /** Log specialist execution completed successfully */
  specialistCompleted(fields: SpecialistLogFields): void
  /** Log specialist execution failed */
  specialistFailed(fields: SpecialistLogFields): void
  /** Log task retry with optional escalation */
  taskRetried(fields: SpecialistLogFields & {
    maxRetries?: number
    escalation?: { fromModel: string; toModel: string }
    reason?: string
  }): void
  /** Log concurrency event (semaphore) */
  concurrencyEvent(fields: {
    event: 'acquired' | 'released' | 'queued' | 'limit_reached'
    active: number
    max: number
    queued?: number
    taskId?: string
  }): void
  /** Log tool call circuit breaker */
  toolCallLimitReached(fields: SpecialistLogFields & {
    toolCallCount: number
    maxToolCalls: number
  }): void
  /** Log scheduling decision */
  schedulingDecision(fields: {
    strategy: string
    rankedCount: number
    startedCount: number
    pendingCount: number
  }): void
}

/**
 * Format structured fields as a compact JSON suffix for log lines.
 * Filters out undefined values for clean output.
 */
function formatFields(fields: Record<string, unknown>): string {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      clean[key] = value
    }
  }
  return JSON.stringify(clean)
}

/**
 * Create a structured logger wrapping an electron-log scoped logger.
 * Each method logs a human-readable message followed by structured JSON fields.
 */
export function createStructuredLogger(log: LogFunctions): StructuredLogger {
  return {
    specialistStarted(fields) {
      log.info(
        `[SPECIALIST:start] ${fields.agentId}/${fields.taskId} model=${fields.model ?? 'sonnet'} ${formatFields(fields)}`
      )
    },

    specialistCompleted(fields) {
      log.info(
        `[SPECIALIST:complete] ${fields.agentId}/${fields.taskId} duration=${fields.durationMs}ms tokens=${fields.tokenUsage?.total ?? 0} ${formatFields(fields)}`
      )
    },

    specialistFailed(fields) {
      log.error(
        `[SPECIALIST:failed] ${fields.agentId}/${fields.taskId} error=${fields.error} attempt=${fields.attempt ?? 1} ${formatFields(fields)}`
      )
    },

    taskRetried(fields) {
      const escalationStr = fields.escalation
        ? ` escalation=${fields.escalation.fromModel}→${fields.escalation.toModel}`
        : ''
      log.warn(
        `[SPECIALIST:retry] ${fields.agentId}/${fields.taskId} attempt=${fields.attempt}/${fields.maxRetries}${escalationStr} ${formatFields(fields)}`
      )
    },

    concurrencyEvent(fields) {
      log.debug(
        `[CONCURRENCY:${fields.event}] active=${fields.active}/${fields.max} ${formatFields(fields)}`
      )
    },

    toolCallLimitReached(fields) {
      log.warn(
        `[SPECIALIST:tool-limit] ${fields.agentId}/${fields.taskId} toolCalls=${fields.toolCallCount}/${fields.maxToolCalls} ${formatFields(fields)}`
      )
    },

    schedulingDecision(fields) {
      log.debug(
        `[SCHEDULING:${fields.strategy}] ranked=${fields.rankedCount} started=${fields.startedCount} pending=${fields.pendingCount} ${formatFields(fields)}`
      )
    }
  }
}
