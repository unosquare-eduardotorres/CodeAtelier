/**
 * Tests for AgentSessionRepository — CRUD, token tracking, completion, summaries.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('AgentSessionRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { agentSessionRepository } = require('../agent-session.repository')

  describe('AgentSessionRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      assert.ok(session.id)
      assert.equal(session.agentType, 'da-vinci')
      assert.equal(session.status, 'running')
      assert.equal(session.tokenUsage, 0)
      assert.equal(session.inputTokens, 0)
      assert.equal(session.outputTokens, 0)
      assert.equal(session.cacheReadTokens, 0)
      assert.equal(session.cacheCreationTokens, 0)
      assert.equal(session.workspaceId, wsId)
      assert.equal(session.endedAt, null)
    })

    test('create() accepts all optional fields', () => {
      const convId = seedConversation(db, wsId)
      const session = agentSessionRepository.create('builder', {
        taskId: 'task-1',
        pid: 12345,
        conversationId: convId,
        workspaceId: wsId,
        complexityScore: 0.85,
        modelUsed: 'claude-sonnet-4-6',
        complexityTier: 'high'
      })
      assert.equal(session.taskId, 'task-1')
      assert.equal(session.pid, 12345)
      assert.equal(session.conversationId, convId)
      assert.equal(session.complexityScore, 0.85)
      assert.equal(session.modelUsed, 'claude-sonnet-4-6')
      assert.equal(session.complexityTier, 'high')
    })

    test('findById() round-trip', () => {
      const created = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      const found = agentSessionRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.agentType, 'da-vinci')
    })

    test('findById() returns undefined for unknown', () => {
      const found = agentSessionRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('complete() sets status, endedAt, tokenUsage', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      agentSessionRepository.complete(session.id, 'completed', 5000)
      const updated = agentSessionRepository.findById(session.id)
      assert.equal(updated!.status, 'completed')
      assert.ok(updated!.endedAt)
      assert.equal(updated!.tokenUsage, 5000)
    })

    test('completeWithBreakdown() stores granular token data', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      agentSessionRepository.completeWithBreakdown(session.id, 'completed', {
        total: 10000,
        input: 6000,
        output: 3000,
        cacheRead: 500,
        cacheCreation: 500
      })
      const updated = agentSessionRepository.findById(session.id)
      assert.equal(updated!.tokenUsage, 10000)
      assert.equal(updated!.inputTokens, 6000)
      assert.equal(updated!.outputTokens, 3000)
      assert.equal(updated!.cacheReadTokens, 500)
      assert.equal(updated!.cacheCreationTokens, 500)
    })

    test('updateConversationId() links session to conversation', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      const convId = seedConversation(db, wsId)
      agentSessionRepository.updateConversationId(session.id, convId)
      const updated = agentSessionRepository.findById(session.id)
      assert.equal(updated!.conversationId, convId)
    })

    test('updateTokenUsage() without breakdown', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      agentSessionRepository.updateTokenUsage(session.id, 3000)
      const updated = agentSessionRepository.findById(session.id)
      assert.equal(updated!.tokenUsage, 3000)
    })

    test('updateTokenUsage() with breakdown', () => {
      const session = agentSessionRepository.create('da-vinci', { workspaceId: wsId })
      agentSessionRepository.updateTokenUsage(session.id, 8000, {
        input: 5000,
        output: 2000,
        cacheRead: 500,
        cacheCreation: 500
      })
      const updated = agentSessionRepository.findById(session.id)
      assert.equal(updated!.tokenUsage, 8000)
      assert.equal(updated!.inputTokens, 5000)
    })

    test('findByWorkspace() returns sessions for workspace', () => {
      const sessions = agentSessionRepository.findByWorkspace(wsId)
      assert.ok(Array.isArray(sessions))
      assert.ok(sessions.length > 0)
    })

    test('getTokenSummary() aggregates correctly', () => {
      const summary = agentSessionRepository.getTokenSummary(wsId)
      assert.ok(typeof summary.totalTokens === 'number')
      assert.ok(typeof summary.sessionCount === 'number')
      assert.ok(Array.isArray(summary.byAgent))
      assert.ok(typeof summary.totalContextTokens === 'number')
      assert.ok(typeof summary.totalTurns === 'number')
    })

    test('getConversationTokenSummary() works for conversation', () => {
      const convId = seedConversation(db, wsId)
      const session = agentSessionRepository.create('da-vinci', {
        workspaceId: wsId,
        conversationId: convId
      })
      agentSessionRepository.complete(session.id, 'completed', 1000)
      const summary = agentSessionRepository.getConversationTokenSummary(convId)
      assert.ok(summary.totalTokens >= 1000)
      assert.ok(summary.sessionCount >= 1)
    })

    test('terminateStale() marks running as terminated', () => {
      agentSessionRepository.create('stale-agent', { workspaceId: wsId })
      const terminated = agentSessionRepository.terminateStale()
      assert.ok(terminated >= 1)
    })

    test('getRecent() returns limited results', () => {
      const recent = agentSessionRepository.getRecent(wsId, 5)
      assert.ok(Array.isArray(recent))
      assert.ok(recent.length <= 5)
    })
  })
}
