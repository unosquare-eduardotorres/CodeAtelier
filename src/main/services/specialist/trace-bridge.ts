/**
 * Bridges ExecutionTracer events to EventLoggerService.
 *
 * Single point of truth: instrument the tracer, and both real-time
 * trace listeners AND persistent DB logging are covered.
 * Eliminates duplicate eventLoggerService calls in specialist-pool.service.ts
 * for events that already correspond to trace spans.
 */
import { executionTracer } from './trace'
import type { TraceEvent } from './trace'
import { eventLoggerService } from '../event-logger.service'

/**
 * Wire trace events to the event logger.
 * Call once at app startup. Returns unsubscribe function.
 */
export function bridgeTracerToEventLogger(): () => void {
  return executionTracer.onTrace((event: TraceEvent) => {
    const conversationId = event.metadata?.conversationId as string | undefined

    switch (event.type) {
      case 'specialist_start':
        eventLoggerService.logAgentStarted({
          conversationId,
          agentId: event.agentId ?? 'unknown',
          taskId: event.taskId,
          model: event.metadata?.model as string | undefined,
          complexityTier: event.metadata?.complexityTier as string | undefined
        })
        break

      case 'specialist_end':
        if (event.metadata?.error) {
          eventLoggerService.logAgentFailed({
            conversationId,
            agentId: event.agentId ?? 'unknown',
            taskId: event.taskId,
            error: event.metadata.error as string,
            attempt: event.metadata?.attempt as number | undefined
          })
        } else {
          eventLoggerService.logAgentCompleted({
            conversationId,
            agentId: event.agentId ?? 'unknown',
            taskId: event.taskId,
            tokenUsage: (event.tokenUsage?.input ?? 0) + (event.tokenUsage?.output ?? 0)
          })
        }
        break

      case 'task_retry':
        eventLoggerService.logAgentFailed({
          conversationId,
          agentId: event.agentId ?? 'unknown',
          taskId: event.taskId,
          error: event.message ?? 'Task retry',
          attempt: event.metadata?.attempt as number | undefined
        })
        break

      // Other event types can be mapped as needed
    }
  })
}
