/**
 * Unit tests for event-logger-formatters.ts — pure message formatters
 * extracted from EventLoggerService.
 *
 * Covers:
 * - formatGateResultMessage: passed/failed status, eventType, summary
 * - formatBudgetWarningMessage: currency formatting, percentage rounding
 * - formatBudgetExceededMessage: currency formatting
 * - formatEscalationMessage: model names, reason
 * - formatAgentMessage: started/completed/failed, taskId
 * - formatSessionMessage: started/failed, error inclusion
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  formatGateResultMessage,
  formatBudgetWarningMessage,
  formatBudgetExceededMessage,
  formatEscalationMessage,
  formatAgentMessage,
  formatSessionMessage
} from '../event-logger-formatters'

// ── formatGateResultMessage ──

describe('formatGateResultMessage', () => {
  test('formats passed gate correctly', () => {
    const result = formatGateResultMessage({ type: 'lint', passed: true, summary: 'No issues' })
    assert.equal(result.eventType, 'gate.lint.pass')
    assert.equal(result.message, '[PASSED] lint: No issues')
  })

  test('formats failed gate correctly', () => {
    const result = formatGateResultMessage({
      type: 'typecheck',
      passed: false,
      summary: '3 errors found'
    })
    assert.equal(result.eventType, 'gate.typecheck.fail')
    assert.equal(result.message, '[FAILED] typecheck: 3 errors found')
  })

  test('includes gate type in eventType', () => {
    const result = formatGateResultMessage({ type: 'security-scan', passed: true, summary: 'OK' })
    assert.equal(result.eventType, 'gate.security-scan.pass')
  })

  test('includes summary in message', () => {
    const result = formatGateResultMessage({
      type: 'test',
      passed: false,
      summary: 'Tests failed with 12 errors'
    })
    assert.ok(result.message.includes('Tests failed with 12 errors'))
  })
})

// ── formatBudgetWarningMessage ──

describe('formatBudgetWarningMessage', () => {
  test('converts cents to dollars with 2 decimal places', () => {
    const result = formatBudgetWarningMessage({
      currentCostCents: 1234,
      budgetCents: 5000,
      percentUsed: 24.68
    })
    assert.ok(result.message.includes('$12.34'))
    assert.ok(result.message.includes('$50.00'))
  })

  test('rounds percentage to integer', () => {
    const result = formatBudgetWarningMessage({
      currentCostCents: 750,
      budgetCents: 1000,
      percentUsed: 75.4
    })
    assert.ok(result.message.includes('75%'))
  })

  test('sets correct eventType', () => {
    const result = formatBudgetWarningMessage({
      currentCostCents: 100,
      budgetCents: 200,
      percentUsed: 50
    })
    assert.equal(result.eventType, 'budget.warning')
  })

  test('handles zero costs', () => {
    const result = formatBudgetWarningMessage({
      currentCostCents: 0,
      budgetCents: 5000,
      percentUsed: 0
    })
    assert.ok(result.message.includes('$0.00'))
    assert.ok(result.message.includes('0%'))
  })
})

// ── formatBudgetExceededMessage ──

describe('formatBudgetExceededMessage', () => {
  test('formats exceeded message with dollar amounts', () => {
    const result = formatBudgetExceededMessage({
      currentCostCents: 6000,
      budgetCents: 5000
    })
    assert.equal(result.message, 'Budget exceeded: $60.00 > $50.00')
    assert.equal(result.eventType, 'budget.exceeded')
  })

  test('handles small cent amounts', () => {
    const result = formatBudgetExceededMessage({
      currentCostCents: 3,
      budgetCents: 1
    })
    assert.ok(result.message.includes('$0.03'))
    assert.ok(result.message.includes('$0.01'))
  })
})

// ── formatEscalationMessage ──

describe('formatEscalationMessage', () => {
  test('includes all escalation details', () => {
    const result = formatEscalationMessage({
      agentId: 'specialist-a',
      fromModel: 'claude-haiku-4-5',
      toModel: 'claude-sonnet-4-6',
      reason: 'complexity exceeded threshold'
    })
    assert.equal(result.eventType, 'escalation.model')
    assert.equal(
      result.message,
      'Escalated specialist-a from claude-haiku-4-5 to claude-sonnet-4-6: complexity exceeded threshold'
    )
  })

  test('handles empty reason', () => {
    const result = formatEscalationMessage({
      agentId: 'agent-1',
      fromModel: 'gpt-4o-mini',
      toModel: 'gpt-4o',
      reason: ''
    })
    assert.ok(result.message.endsWith(': '))
  })
})

// ── formatAgentMessage ──

describe('formatAgentMessage', () => {
  test('formats agent started message', () => {
    const result = formatAgentMessage('started', { agentId: 'spec-1', taskId: 'T-001' })
    assert.equal(result.eventType, 'agent.started')
    assert.equal(result.message, 'Specialist spec-1 started task T-001')
  })

  test('formats agent completed message', () => {
    const result = formatAgentMessage('completed', { agentId: 'spec-2', taskId: 'T-002' })
    assert.equal(result.eventType, 'agent.completed')
    assert.equal(result.message, 'Specialist spec-2 completed task T-002')
  })

  test('formats agent failed message with error', () => {
    const result = formatAgentMessage('failed', {
      agentId: 'spec-3',
      taskId: 'T-003',
      error: 'timeout'
    })
    assert.equal(result.eventType, 'agent.failed')
    assert.equal(result.message, 'Specialist spec-3 failed task T-003: timeout')
  })

  test('uses "unknown" for missing taskId', () => {
    const result = formatAgentMessage('started', { agentId: 'spec-4' })
    assert.ok(result.message.includes('task unknown'))
  })
})

// ── formatSessionMessage ──

describe('formatSessionMessage', () => {
  test('formats session started', () => {
    const result = formatSessionMessage('started', { agentId: 'da-vinci' })
    assert.equal(result.eventType, 'session.started')
    assert.equal(result.message, 'Agent da-vinci session started')
  })

  test('formats session failed with error', () => {
    const result = formatSessionMessage('failed', {
      agentId: 'spec-1',
      error: 'connection refused'
    })
    assert.equal(result.eventType, 'session.failed')
    assert.equal(result.message, 'Agent spec-1 session failed: connection refused')
  })

  test('formats session failed with missing error as unknown', () => {
    const result = formatSessionMessage('failed', { agentId: 'spec-2' })
    assert.ok(result.message.includes('unknown error'))
  })
})

// ── Standalone runner ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
