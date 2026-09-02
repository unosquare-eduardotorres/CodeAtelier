/**
 * Tests for TurnUsageRepository — record, query, context tokens, pruning.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('TurnUsageRepository (skipped — native module unavailable)', () => {
    test('record()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { turnUsageRepository } = require('../turn-usage.repository')

  // Seed an agent session for FK satisfaction
  function seedSession(conversationId: string): string {
    const row = db
      .prepare(
        `INSERT INTO agent_sessions (agent_type, conversation_id, workspace_id)
       VALUES (?, ?, ?) RETURNING id`
      )
      .get('da-vinci', conversationId, wsId) as { id: string }
    return row.id
  }

  describe('TurnUsageRepository', () => {
    test('record() returns mapped model', () => {
      const convId = seedConversation(db, wsId)
      const sessionId = seedSession(convId)
      const turn = turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        model: 'claude-sonnet-4-6'
      })
      assert.ok(turn.id)
      assert.equal(turn.sessionId, sessionId)
      assert.equal(turn.conversationId, convId)
      assert.equal(turn.turnNumber, 1)
      assert.equal(turn.inputTokens, 1000)
      assert.equal(turn.outputTokens, 500)
      assert.equal(turn.cacheReadTokens, 200)
      assert.equal(turn.cacheCreationTokens, 100)
      assert.equal(turn.model, 'claude-sonnet-4-6')
      assert.equal(turn.contextTokens, 0) // default
    })

    // ── v150 attribution ──

    test('record() round-trips provider/blueprint/task/attempt', () => {
      const convId = seedConversation(db, wsId, 'Attribution')
      const sessionId = seedSession(convId)
      const turn = turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        provider: 'opencode',
        blueprintId: 'bp-1',
        taskId: 'T3',
        attempt: 2
      })
      assert.equal(turn.provider, 'opencode')
      assert.equal(turn.blueprintId, 'bp-1')
      assert.equal(turn.taskId, 'T3')
      assert.equal(turn.attempt, 2)

      // Survives a re-read, not just the RETURNING row.
      const reread = turnUsageRepository.getLastTurn(convId)
      assert.equal(reread!.provider, 'opencode')
      assert.equal(reread!.blueprintId, 'bp-1')
      assert.equal(reread!.taskId, 'T3')
      assert.equal(reread!.attempt, 2)
    })

    test('record() leaves attribution NULL when omitted', () => {
      const convId = seedConversation(db, wsId, 'No Attribution')
      const sessionId = seedSession(convId)
      const turn = turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      assert.equal(turn.provider, null)
      assert.equal(turn.blueprintId, null)
      assert.equal(turn.taskId, null)
      assert.equal(turn.attempt, null)
    })

    test('record() defaults model to null', () => {
      const convId = seedConversation(db, wsId)
      const sessionId = seedSession(convId)
      const turn = turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      assert.equal(turn.model, null)
    })

    test('findByConversation() returns turns ordered by turn_number', () => {
      const convId = seedConversation(db, wsId, 'Turn Conv')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 2,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })

      const turns = turnUsageRepository.findByConversation(convId)
      assert.ok(turns.length >= 2)
      assert.equal(turns[0].turnNumber, 1)
      assert.equal(turns[1].turnNumber, 2)
    })

    test('getLastTurn() returns most recent turn', () => {
      const convId = seedConversation(db, wsId, 'Last Turn')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 2,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })

      const last = turnUsageRepository.getLastTurn(convId)
      assert.ok(last)
      assert.equal(last.turnNumber, 2)
      assert.equal(last.inputTokens, 200)
    })

    test('getLastTurn() returns null for conversation with no turns', () => {
      const convId = seedConversation(db, wsId, 'Empty Turns')
      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last, null)
    })

    test('updateLastTurnContextTokens() stores context window size', () => {
      const convId = seedConversation(db, wsId, 'Context Tokens')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 100,
        cacheCreationTokens: 50
      })

      turnUsageRepository.updateLastTurnContextTokens(convId, 45000)
      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last!.contextTokens, 45000)
      // Original cache values preserved
      assert.equal(last!.cacheReadTokens, 100)
      assert.equal(last!.cacheCreationTokens, 50)
      // Omitting the prefix leaves it unmeasured rather than recording a zero.
      assert.equal(last!.prefixTokens, null)
    })

    test('updateLastTurnContextTokens() stores prefix and context in one write', () => {
      const convId = seedConversation(db, wsId, 'Prefix Tokens')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 22,
        outputTokens: 500,
        cacheReadTokens: 1_014_653,
        cacheCreationTokens: 0
      })

      // The two numbers are deliberately different quantities: 103 K is what the
      // window held at the END of the agentic loop, 28 K is the prompt that was
      // actually sent on the first call. Reading the former as a "prefix floor"
      // is what made Gate T unreachable.
      turnUsageRepository.updateLastTurnContextTokens(convId, 102_986, 28_400)
      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last!.contextTokens, 102_986)
      assert.equal(last!.prefixTokens, 28_400)
      assert.equal(last!.cacheReadTokens, 1_014_653, 'cache data untouched')
    })

    test('updateLastTurnContextTokens() does not erase a recorded prefix', () => {
      const convId = seedConversation(db, wsId, 'Prefix Preserved')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })

      turnUsageRepository.updateLastTurnContextTokens(convId, 50_000, 24_000)
      // A later write with no prefix (or a zero one) must not overwrite the
      // measurement with an absence.
      turnUsageRepository.updateLastTurnContextTokens(convId, 90_000)
      turnUsageRepository.updateLastTurnContextTokens(convId, 95_000, 0)

      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last!.contextTokens, 95_000, 'occupancy still tracks the latest value')
      assert.equal(last!.prefixTokens, 24_000)
    })

    test('pruneOlderThan() removes old records', () => {
      // Insert old turn usage directly
      const convId = seedConversation(db, wsId, 'Prune Conv')
      const sessionId = seedSession(convId)
      db.prepare(
        `INSERT INTO turn_usage (session_id, conversation_id, turn_number, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '-200 days'))`
      ).run(sessionId, convId, 1, 100, 50, 0, 0)

      const pruned = turnUsageRepository.pruneOlderThan(180)
      assert.ok(pruned >= 1)
    })

    test('toModel() maps all fields including contextTokens default', () => {
      const convId = seedConversation(db, wsId, 'Model Map')
      const sessionId = seedSession(convId)
      const turn = turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 500,
        outputTokens: 250,
        cacheReadTokens: 50,
        cacheCreationTokens: 25
      })
      assert.ok(typeof turn.id === 'string')
      assert.ok(typeof turn.createdAt === 'string')
      assert.equal(turn.contextTokens, 0) // default from ?? 0
    })

    // ── Phase 6C: Untested methods ──

    test('updateLastTurnTokens() updates token fields on most recent turn', () => {
      const convId = seedConversation(db, wsId, 'Update Tokens')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5
      })
      // Update the last turn's token values
      turnUsageRepository.updateLastTurnTokens(convId, {
        inputTokens: 999,
        cacheReadTokens: 888,
        cacheCreationTokens: 777
      })
      const updated = turnUsageRepository.getLastTurn(convId)
      assert.ok(updated)
      assert.equal(updated!.inputTokens, 999)
      assert.equal(updated!.cacheReadTokens, 888)
      assert.equal(updated!.cacheCreationTokens, 777)
    })
  })
}
