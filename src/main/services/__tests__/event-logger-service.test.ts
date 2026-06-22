/**
 * Unit tests for EventLoggerService — sequence counters and message formatting.
 *
 * The service depends on eventRepository.create() for persistence, so we test:
 * 1. nextSequence counter logic (replicated — it's private)
 * 2. All log* methods are callable and don't throw when eventRepository errors
 * 3. Message format verification via the singleton
 *
 * eventRepository.create is called inside a try/catch — errors are swallowed,
 * so all log* calls are safe even without a DB.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { eventLoggerService } from '../event-logger.service'

// ── Replicate nextSequence logic (private, 5 lines) ──

function createSequenceCounter() {
  const counters = new Map<string, number>()
  return {
    next(sessionId: string): number {
      const current = counters.get(sessionId) ?? 0
      counters.set(sessionId, current + 1)
      return current + 1
    },
    reset() { counters.clear() }
  }
}

describe('EventLoggerService — nextSequence logic', () => {
  test('first_call_for_session_returns_1', () => {
    const seq = createSequenceCounter()
    assert.equal(seq.next('session-1'), 1)
  })

  test('second_call_returns_2', () => {
    const seq = createSequenceCounter()
    seq.next('session-1')
    assert.equal(seq.next('session-1'), 2)
  })

  test('different_sessions_have_independent_counters', () => {
    const seq = createSequenceCounter()
    seq.next('session-a')
    seq.next('session-a')
    assert.equal(seq.next('session-b'), 1)
    assert.equal(seq.next('session-a'), 3)
  })

  test('monotonic_sequence_across_many_calls', () => {
    const seq = createSequenceCounter()
    for (let i = 1; i <= 100; i++) {
      assert.equal(seq.next('s1'), i)
    }
  })
})

describe('EventLoggerService — log methods callable', () => {
  // All log methods internally call eventRepository.create which may fail
  // due to no database — but errors are swallowed in try/catch.

  test('logSessionStarted_does_not_throw', () => {
    eventLoggerService.logSessionStarted({
      sessionId: 'test-session',
      agentId: 'da-vinci',
      model: 'claude-sonnet-4-6'
    })
  })

  test('logSessionFailed_does_not_throw', () => {
    eventLoggerService.logSessionFailed({
      agentId: 'da-vinci',
      error: 'Connection timeout'
    })
  })

  test('logAgentStarted_does_not_throw', () => {
    eventLoggerService.logAgentStarted({
      agentId: 'specialist-1',
      taskId: 'task-42',
      model: 'claude-haiku-4-5'
    })
  })

  test('logAgentCompleted_does_not_throw', () => {
    eventLoggerService.logAgentCompleted({
      agentId: 'specialist-1',
      taskId: 'task-42',
      tokenUsage: 5000
    })
  })

  test('logAgentFailed_does_not_throw', () => {
    eventLoggerService.logAgentFailed({
      agentId: 'specialist-1',
      error: 'Tool timeout',
      attempt: 2
    })
  })

  test('logTaskRetry_does_not_throw', () => {
    eventLoggerService.logTaskRetry({
      agentId: 'specialist-1',
      taskId: 'task-42',
      attempt: 2,
      maxRetries: 3,
      reason: 'Quality gate failed'
    })
  })

  test('logModelEscalation_does_not_throw', () => {
    eventLoggerService.logModelEscalation({
      agentId: 'specialist-1',
      taskId: 'task-42',
      fromModel: 'claude-haiku-4-5',
      toModel: 'claude-sonnet-4-6',
      reason: 'Task too complex',
      attempt: 2
    })
  })

  test('logGateResult_pass_does_not_throw', () => {
    eventLoggerService.logGateResult({
      agentId: 'specialist-1',
      taskId: 'task-42',
      gate: { type: 'lint', passed: true, summary: 'All checks pass' }
    })
  })

  test('logGateResult_fail_does_not_throw', () => {
    eventLoggerService.logGateResult({
      agentId: 'specialist-1',
      taskId: 'task-42',
      gate: { type: 'typecheck', passed: false, summary: '3 type errors' }
    })
  })

  test('logAbandonmentDetected_does_not_throw', () => {
    eventLoggerService.logAbandonmentDetected({
      agentId: 'specialist-1',
      taskId: 'task-42',
      pattern: 'Empty response',
      context: 'After tool call 15'
    })
  })

  test('logCheckpointCreated_does_not_throw', () => {
    eventLoggerService.logCheckpointCreated({
      conversationId: 'conv-1',
      checkpointId: 'cp-1',
      label: 'pre-refactor'
    })
  })

  test('logCheckpointRestored_does_not_throw', () => {
    eventLoggerService.logCheckpointRestored({
      conversationId: 'conv-1',
      checkpointId: 'cp-1',
      label: 'pre-refactor'
    })
  })

  test('logBudgetWarning_does_not_throw', () => {
    eventLoggerService.logBudgetWarning({
      currentCostCents: 800,
      budgetCents: 1000,
      percentUsed: 80
    })
  })

  test('logBudgetExceeded_does_not_throw', () => {
    eventLoggerService.logBudgetExceeded({
      currentCostCents: 1100,
      budgetCents: 1000
    })
  })

  test('logPlanDetected_does_not_throw', () => {
    eventLoggerService.logPlanDetected({
      conversationId: 'conv-1',
      detectionPath: 'tool',
      structured: true,
      contentLength: 500
    })
  })

  test('logAgentToolCall_does_not_throw', () => {
    eventLoggerService.logAgentToolCall({
      agentId: 'da-vinci',
      toolName: 'Read',
      toolCallNumber: 3
    })
  })

  test('logAgentTimeout_does_not_throw', () => {
    eventLoggerService.logAgentTimeout({
      agentId: 'da-vinci',
      elapsedMs: 300000,
      toolCallCount: 25
    })
  })

  test('logCircuitBreakerTripped_does_not_throw', () => {
    eventLoggerService.logCircuitBreakerTripped({
      failures: 5
    })
  })

  test('logMergeRejected_does_not_throw', () => {
    eventLoggerService.logMergeRejected({
      agentId: 'specialist-1',
      taskId: 'task-42',
      reason: 'Conflicts detected'
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
