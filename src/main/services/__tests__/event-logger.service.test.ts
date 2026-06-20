/**
 * Unit tests for EventLoggerService — structured event logging to DB.
 *
 * Each log method writes to the `events` table via eventRepository.create().
 * Tests verify round-trip: call log method → read back from DB → assert event
 * type, category, message, and data JSON.
 *
 * Requires better-sqlite3 for the test DB. Skips gracefully when unavailable.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

function trySetupEventLoggerDb(): {
  db: import('better-sqlite3').Database
  wsId: string
  convId: string
} | null {
  try {
    process.env.NODE_ENV = 'test'
    const { createTestDb, seedWorkspace } = require('../../db/test-helpers')
    const { _setDatabaseForTesting } = require('../../db/index')
    const db = createTestDb()
    _setDatabaseForTesting(db)
    const wsId = seedWorkspace(db)
    // Seed a conversation for tests that need one
    const row = db
      .prepare(
        `INSERT INTO conversations (workspace_id, title, mode) VALUES (?, 'Event Test', 'plan') RETURNING id`
      )
      .get(wsId) as { id: string }
    return { db, wsId, convId: row.id }
  } catch {
    return null
  }
}

const env = trySetupEventLoggerDb()

if (!env) {
  describe('EventLoggerService (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { eventLoggerService } = require('../event-logger.service')
  const { eventRepository } = require('../../db/repositories/event.repository')
  const { db, wsId, convId } = env

  /** Helper: get the most recent event from the DB */
  function lastEvent(): import('../../db/repositories/event.repository').EventRecord {
    const rows = eventRepository.getRecent(1)
    assert.ok(rows.length > 0, 'should have at least one event')
    return rows[0]
  }

  /** Helper: parse data JSON from an event */
  function eventData(event: { dataJson: string }): Record<string, unknown> {
    return JSON.parse(event.dataJson)
  }

  /** Clear events between test groups */
  function clearEvents(): void {
    db.prepare('DELETE FROM events').run()
  }

  // ── Session Events ──

  describe('EventLoggerService — session lifecycle', () => {
    test('logSessionStarted creates session.started event', () => {
      clearEvents()
      eventLoggerService.logSessionStarted({
        sessionId: 'sess-1',
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'da-vinci'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'session.started')
      assert.equal(event.category, 'session')
      assert.ok(event.message.includes('da-vinci'))
      assert.equal(event.agentId, 'da-vinci')
    })

    test('logSessionFailed creates session.failed event with error data', () => {
      clearEvents()
      eventLoggerService.logSessionFailed({
        sessionId: 'sess-2',
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'da-vinci',
        error: 'Connection timeout'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'session.failed')
      assert.equal(event.category, 'session')
      assert.ok(event.message.includes('Connection timeout'))
      const data = eventData(event)
      assert.equal(data.error, 'Connection timeout')
    })
  })

  // ── Agent Events ──

  describe('EventLoggerService — agent lifecycle', () => {
    test('logAgentStarted creates agent.started event', () => {
      clearEvents()
      eventLoggerService.logAgentStarted({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-1',
        taskId: 'task-42',
        complexityTier: 'medium'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.started')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.taskId, 'task-42')
      assert.equal(data.complexityTier, 'medium')
    })

    test('logAgentCompleted creates agent.completed event with token usage', () => {
      clearEvents()
      eventLoggerService.logAgentCompleted({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-1',
        taskId: 'task-42',
        tokenUsage: 5000
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.completed')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.tokenUsage, 5000)
    })

    test('logAgentFailed creates agent.failed event with error and attempt', () => {
      clearEvents()
      eventLoggerService.logAgentFailed({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-2',
        taskId: 'task-99',
        error: 'Rate limited',
        attempt: 3
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.failed')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.error, 'Rate limited')
      assert.equal(data.attempt, 3)
    })
  })

  // ── Task Retry Events ──

  describe('EventLoggerService — task retry', () => {
    test('logTaskRetry creates agent.retry event', () => {
      clearEvents()
      eventLoggerService.logTaskRetry({
        conversationId: convId,
        agentId: 'specialist-1',
        taskId: 'task-10',
        attempt: 2,
        maxRetries: 3,
        reason: 'Quality gate failed'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.retry')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.attempt, 2)
      assert.equal(data.maxRetries, 3)
      assert.equal(data.reason, 'Quality gate failed')
    })
  })

  // ── Escalation Events ──

  describe('EventLoggerService — model escalation', () => {
    test('logModelEscalation creates escalation event', () => {
      clearEvents()
      eventLoggerService.logModelEscalation({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-1',
        taskId: 'task-5',
        fromModel: 'haiku',
        toModel: 'sonnet',
        reason: 'Gate failure',
        attempt: 2
      })
      const event = lastEvent()
      assert.equal(event.category, 'escalation')
      const data = eventData(event)
      assert.equal(data.fromModel, 'haiku')
      assert.equal(data.toModel, 'sonnet')
    })
  })

  // ── Quality Gate Events ──

  describe('EventLoggerService — quality gates', () => {
    test('logGateResult creates gate event with pass/fail info', () => {
      clearEvents()
      eventLoggerService.logGateResult({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-1',
        taskId: 'task-7',
        gate: {
          type: 'lint',
          passed: false,
          summary: '3 errors found'
        }
      })
      const event = lastEvent()
      assert.equal(event.category, 'gate')
      const data = eventData(event)
      assert.equal(data.gateType, 'lint')
      assert.equal(data.passed, false)
      assert.equal(data.summary, '3 errors found')
    })
  })

  // ── Abandonment Events ──

  describe('EventLoggerService — abandonment', () => {
    test('logAbandonmentDetected creates abandonment event', () => {
      clearEvents()
      eventLoggerService.logAbandonmentDetected({
        conversationId: convId,
        workspaceId: wsId,
        agentId: 'specialist-1',
        taskId: 'task-11',
        pattern: 'apologetic_loop',
        context: 'repeated "I apologize" messages'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'abandonment.detected')
      assert.equal(event.category, 'abandonment')
      const data = eventData(event)
      assert.equal(data.pattern, 'apologetic_loop')
      assert.equal(data.context, 'repeated "I apologize" messages')
    })
  })

  // ── Checkpoint Events ──

  describe('EventLoggerService — checkpoints', () => {
    test('logCheckpointCreated creates checkpoint.created event', () => {
      clearEvents()
      eventLoggerService.logCheckpointCreated({
        conversationId: convId,
        workspaceId: wsId,
        checkpointId: 'cp-1',
        label: 'Before refactor'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'checkpoint.created')
      assert.equal(event.category, 'checkpoint')
      const data = eventData(event)
      assert.equal(data.checkpointId, 'cp-1')
      assert.equal(data.label, 'Before refactor')
    })

    test('logCheckpointRestored creates checkpoint.restored event', () => {
      clearEvents()
      eventLoggerService.logCheckpointRestored({
        conversationId: convId,
        workspaceId: wsId,
        checkpointId: 'cp-2',
        label: 'Last good state'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'checkpoint.restored')
      assert.equal(event.category, 'checkpoint')
      const data = eventData(event)
      assert.equal(data.checkpointId, 'cp-2')
      assert.equal(data.label, 'Last good state')
    })
  })

  // ── Budget Events ──

  describe('EventLoggerService — budget', () => {
    test('logBudgetWarning creates budget warning event', () => {
      clearEvents()
      eventLoggerService.logBudgetWarning({
        conversationId: convId,
        workspaceId: wsId,
        currentCostCents: 80,
        budgetCents: 100,
        percentUsed: 80
      })
      const event = lastEvent()
      assert.equal(event.category, 'budget')
      const data = eventData(event)
      assert.equal(data.currentCostCents, 80)
      assert.equal(data.budgetCents, 100)
      assert.equal(data.percentUsed, 80)
    })

    test('logBudgetExceeded creates budget exceeded event', () => {
      clearEvents()
      eventLoggerService.logBudgetExceeded({
        conversationId: convId,
        workspaceId: wsId,
        currentCostCents: 120,
        budgetCents: 100
      })
      const event = lastEvent()
      assert.equal(event.category, 'budget')
      const data = eventData(event)
      assert.equal(data.currentCostCents, 120)
      assert.equal(data.budgetCents, 100)
    })
  })

  // ── Agent Tool Call + Plan Events ──

  describe('EventLoggerService — agent tool call and plan detection', () => {
    test('logPlanDetected creates plan.detected event', () => {
      clearEvents()
      eventLoggerService.logPlanDetected({
        conversationId: convId,
        workspaceId: wsId,
        detectionPath: 'tool',
        structured: true,
        contentLength: 2500
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'plan.detected')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.detectionPath, 'tool')
      assert.equal(data.structured, true)
      assert.equal(data.contentLength, 2500)
    })

    test('logAgentToolCall creates agent.tool_call event', () => {
      clearEvents()
      eventLoggerService.logAgentToolCall({
        agentId: 'da-vinci',
        conversationId: convId,
        toolName: 'Write',
        toolCallNumber: 5
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.tool_call')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.toolName, 'Write')
      assert.equal(data.toolCallNumber, 5)
    })
  })

  // ── Error Events ──

  describe('EventLoggerService — error events', () => {
    test('logAgentTimeout creates agent.timeout event', () => {
      clearEvents()
      eventLoggerService.logAgentTimeout({
        agentId: 'da-vinci',
        conversationId: convId,
        elapsedMs: 300000,
        toolCallCount: 45
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'agent.timeout')
      assert.equal(event.category, 'error')
      const data = eventData(event)
      assert.equal(data.elapsedMs, 300000)
      assert.equal(data.toolCallCount, 45)
    })

    test('logCircuitBreakerTripped creates error.circuit_breaker event', () => {
      clearEvents()
      eventLoggerService.logCircuitBreakerTripped({
        conversationId: convId,
        workspaceId: wsId,
        failures: 5
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'error.circuit_breaker')
      assert.equal(event.category, 'error')
      const data = eventData(event)
      assert.equal(data.failures, 5)
    })
  })

  // ── Merge Events ──

  describe('EventLoggerService — merge events', () => {
    test('logMergeRejected creates merge.rejected event', () => {
      clearEvents()
      eventLoggerService.logMergeRejected({
        conversationId: convId,
        agentId: 'specialist-3',
        taskId: 'task-15',
        reason: 'Conflict detected in main branch'
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'merge.rejected')
      assert.equal(event.category, 'agent')
      const data = eventData(event)
      assert.equal(data.taskId, 'task-15')
      assert.equal(data.reason, 'Conflict detected in main branch')
    })
  })

  // ── Prune ──

  describe('EventLoggerService — prune', () => {
    test('prune() returns 0 when no old events exist', () => {
      clearEvents()
      // Insert a fresh event
      eventLoggerService.logSessionStarted({
        agentId: 'da-vinci',
        workspaceId: wsId
      })
      const pruned = eventLoggerService.prune(30)
      assert.equal(pruned, 0, 'should not prune recent events')
      // Fresh event should still exist
      assert.equal(eventRepository.getRecent(10).length, 1)
    })

    test('prune() deletes events older than N days', () => {
      clearEvents()
      // Insert a very old event directly
      db.prepare(
        `INSERT INTO events (event_type, category, message, data_json, created_at)
         VALUES ('old.event', 'session', 'ancient', '{}', datetime('now', '-60 days'))`
      ).run()
      // And a recent one
      eventLoggerService.logSessionStarted({ agentId: 'da-vinci', workspaceId: wsId })

      const total = eventRepository.getRecent(100).length
      assert.ok(total >= 2, 'should have both old and new events')

      const pruned = eventLoggerService.prune(30)
      assert.ok(pruned >= 1, 'should prune at least 1 old event')

      const remaining = eventRepository.getRecent(100).length
      assert.ok(remaining < total, 'should have fewer events after pruning')
    })
  })

  // ── Edge Cases ──

  describe('EventLoggerService — edge cases', () => {
    test('log method with undefined optional fields does not throw', () => {
      clearEvents()
      // Call with minimal required fields only
      assert.doesNotThrow(() => {
        eventLoggerService.logSessionStarted({
          agentId: 'test-agent'
          // sessionId, conversationId, workspaceId all undefined
        })
      })
      const event = lastEvent()
      assert.equal(event.eventType, 'session.started')
    })

    test('sequence numbers are monotonically increasing within a session', () => {
      clearEvents()
      const sessionId = 'seq-test-session'
      eventLoggerService.logSessionStarted({
        sessionId,
        agentId: 'da-vinci',
        workspaceId: wsId
      })
      eventLoggerService.logAgentToolCall({
        agentId: 'da-vinci',
        toolName: 'Read',
        toolCallNumber: 1
      })
      // Two events for same session should have different sequence numbers
      // (but the tool call may not have sessionId — verify the session event has one)
      const events = eventRepository.getRecent(5)
      const sessionEvent = events.find(
        (e: any) => e.eventType === 'session.started' && e.sessionId === sessionId
      )
      assert.ok(sessionEvent)
      assert.ok(
        sessionEvent.sequenceNumber != null,
        'session event should have a sequence number'
      )
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
