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
      // The context back-fill must not disturb the prefix recorded at INSERT.
      assert.equal(last!.prefixTokens, null)
    })

    test('record() stores the first-call prefix, distinct from context tokens', () => {
      const convId = seedConversation(db, wsId, 'Prefix Tokens')
      const sessionId = seedSession(convId)
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        inputTokens: 22,
        outputTokens: 500,
        cacheReadTokens: 1_014_653,
        cacheCreationTokens: 0,
        prefixTokens: 28_400
      })

      // Deliberately different quantities: 103 K is what the window held at the
      // END of the agentic loop, 28 K is the prompt actually sent on the first
      // call. Reading the former as a "prefix floor" is what made Gate T
      // unreachable — so a later context back-fill must leave the prefix alone.
      turnUsageRepository.updateLastTurnContextTokens(convId, 102_986)

      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last!.prefixTokens, 28_400)
      assert.equal(last!.contextTokens, 102_986)
      assert.equal(last!.cacheReadTokens, 1_014_653, 'cache data untouched')
    })

    test('record() stores NULL for an absent or non-positive prefix', () => {
      const convId = seedConversation(db, wsId, 'Prefix Absent')
      const sessionId = seedSession(convId)
      const base = {
        sessionId,
        conversationId: convId,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }

      // NULL means "never measured" — a stored 0 would read as a measurement and
      // drag any average down. 0 is what a backend with no per-call snapshot
      // produces, so it must not be written as data.
      const omitted = turnUsageRepository.record({ ...base, turnNumber: 1 })
      const zero = turnUsageRepository.record({ ...base, turnNumber: 2, prefixTokens: 0 })
      const negative = turnUsageRepository.record({ ...base, turnNumber: 3, prefixTokens: -5 })

      assert.equal(omitted.prefixTokens, null)
      assert.equal(zero.prefixTokens, null)
      assert.equal(negative.prefixTokens, null)
    })

    test('getBlueprintPrefixStats() reports the floor and how much of it is measured', () => {
      const convId = seedConversation(db, wsId, 'Prefix Stats')
      const sessionId = seedSession(convId)
      const base = {
        sessionId,
        conversationId: convId,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        blueprintId: 'bp-stats'
      }

      // Three BUILD turns, one of them served by a backend that reports no
      // per-call snapshot — the realistic mix once anything runs on OpenCode.
      turnUsageRepository.record({ ...base, turnNumber: 1, inputTokens: 1, taskId: 'T1', prefixTokens: 31_000 })
      turnUsageRepository.record({ ...base, turnNumber: 2, inputTokens: 1, taskId: 'T2', prefixTokens: 25_000 })
      turnUsageRepository.record({ ...base, turnNumber: 3, inputTokens: 1, taskId: 'T3' })
      // A non-BUILD phase turn of the SAME blueprint (blueprint_id, no task_id)
      // and a chat turn (neither) must not enter the floor.
      turnUsageRepository.record({ ...base, turnNumber: 4, inputTokens: 1, prefixTokens: 9_000 })
      turnUsageRepository.record({
        sessionId,
        conversationId: convId,
        turnNumber: 5,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        prefixTokens: 8_000
      })

      // Scoped to this blueprint: the unscoped call spans the whole table, which
      // is what Gate T wants on a real DB but not what a shared test DB gives.
      const stats = turnUsageRepository.getBlueprintPrefixStats('bp-stats')
      assert.equal(stats.turns, 3, 'only per-task BUILD turns count')
      assert.equal(stats.measured, 2, 'the unmeasured turn is reported, not silently averaged in')
      assert.equal(stats.minPrefixTokens, 25_000)
      assert.equal(stats.maxPrefixTokens, 31_000)
      assert.equal(stats.avgPrefixTokens, 28_000)

      const scoped = turnUsageRepository.getBlueprintPrefixStats('bp-other')
      assert.equal(scoped.turns, 0)
      assert.equal(scoped.measured, 0)
      assert.equal(scoped.minPrefixTokens, null, 'no rows means no floor, not zero')
      assert.equal(scoped.avgPrefixTokens, null)
    })

    // ── M1: the floor must survive multi-turn retries ──

    test('getBlueprintPrefixStats() excludes retry turns from the floor by default', () => {
      const convId = seedConversation(db, wsId, 'Prefix Attempts')
      const sessionId = seedSession(convId)
      const base = {
        sessionId,
        conversationId: convId,
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        blueprintId: 'bp-attempts',
        taskId: 'T1'
      }

      // A resumed retry re-sends the whole prior transcript on its first call, so
      // its prefix is far ABOVE the cold floor. If it entered the floor the
      // metric would report durable-session work as a prefix regression — the
      // failure mode this filter exists to prevent.
      turnUsageRepository.record({ ...base, turnNumber: 1, attempt: 1, prefixTokens: 30_000 })
      turnUsageRepository.record({ ...base, turnNumber: 2, attempt: 2, prefixTokens: 96_000 })
      turnUsageRepository.record({ ...base, turnNumber: 3, attempt: 3, prefixTokens: 140_000 })
      // Pre-v150 rows carry no attempt at all and must keep counting.
      turnUsageRepository.record({ ...base, turnNumber: 4, taskId: 'T2', prefixTokens: 26_000 })

      const first = turnUsageRepository.getBlueprintPrefixStats('bp-attempts')
      assert.equal(first.turns, 2, 'attempt-2/3 rows are out of the cold population')
      assert.equal(first.maxPrefixTokens, 30_000, 'the retry prefix never reaches the ceiling')
      assert.equal(first.avgPrefixTokens, 28_000)

      const all = turnUsageRepository.getBlueprintPrefixStats('bp-attempts', { attempts: 'all' })
      assert.equal(all.turns, 4, "'all' opts back into the mixed population")
      assert.equal(all.maxPrefixTokens, 140_000)
    })

    test('getBlueprintRetryContextStats() splits resumed retries from cold ones', () => {
      const warmConv = seedConversation(db, wsId, 'Retry Warm')
      const coldConv = seedConversation(db, wsId, 'Retry Cold')
      const warmSession = seedSession(warmConv)
      const coldSession = seedSession(coldConv)
      const base = {
        inputTokens: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        blueprintId: 'bp-retry'
      }
      const withContext = (turn: { id: string }, contextTokens: number): void => {
        // Targeted by id, not via updateLastTurnContextTokens: that helper resolves
        // "newest row of the conversation", which is exactly the ambiguity this
        // fixture creates on purpose.
        db.prepare('UPDATE turn_usage SET context_tokens = ? WHERE id = ?').run(
          contextTokens,
          turn.id
        )
      }

      // T1 retries by RESUMING: attempt 2 reuses attempt 1's conversation id.
      withContext(
        turnUsageRepository.record({
          ...base,
          sessionId: warmSession,
          conversationId: warmConv,
          turnNumber: 1,
          taskId: 'T1',
          attempt: 1
        }),
        70_000
      )
      withContext(
        turnUsageRepository.record({
          ...base,
          sessionId: warmSession,
          conversationId: warmConv,
          turnNumber: 2,
          taskId: 'T1',
          attempt: 2
        }),
        40_000
      )
      withContext(
        turnUsageRepository.record({
          ...base,
          sessionId: warmSession,
          conversationId: warmConv,
          turnNumber: 3,
          taskId: 'T1',
          attempt: 3
        }),
        60_000
      )

      // T2 retries COLD: a fresh conversation id, so no earlier attempt shares it.
      withContext(
        turnUsageRepository.record({
          ...base,
          sessionId: coldSession,
          conversationId: coldConv,
          turnNumber: 1,
          taskId: 'T2',
          attempt: 2
        }),
        100_000
      )
      // A retry whose backend reported no snapshot: 0 is "never measured", and
      // averaging it in would invent a saving that did not happen.
      turnUsageRepository.record({
        ...base,
        sessionId: coldSession,
        conversationId: coldConv,
        turnNumber: 2,
        taskId: 'T2',
        attempt: 3
      })
      // First attempts are not retries and must not appear in either bucket.
      withContext(
        turnUsageRepository.record({
          ...base,
          sessionId: coldSession,
          conversationId: coldConv,
          turnNumber: 3,
          taskId: 'T3',
          attempt: 1
        }),
        90_000
      )

      const stats = turnUsageRepository.getBlueprintRetryContextStats('bp-retry')
      assert.equal(stats.resumed.turns, 2, 'attempts 2 and 3 continued attempt 1')
      assert.equal(stats.resumed.avgContextTokens, 50_000)
      assert.equal(stats.resumed.medianContextTokens, 50_000, 'even count averages the middle pair')
      assert.equal(stats.cold.turns, 1, 'the unmeasured retry is dropped, not counted as zero')
      assert.equal(stats.cold.avgContextTokens, 100_000)
      assert.equal(stats.cold.medianContextTokens, 100_000)

      const other = turnUsageRepository.getBlueprintRetryContextStats('bp-none')
      assert.equal(other.resumed.turns, 0)
      assert.equal(other.cold.avgContextTokens, null, 'no rows means no average, not zero')
    })

    test('getLastTurn() breaks a turn_number tie towards the newest row', () => {
      const convId = seedConversation(db, wsId, 'Turn Tie')
      const sessionId = seedSession(convId)
      const base = {
        sessionId,
        conversationId: convId,
        turnNumber: 1,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      }

      // Every blueprint-build conversation stores its single turn as turn 1, so
      // a duplicate is one bug away. Without a tie-break SQLite returns whichever
      // row the scan reaches first — the OLDEST — and the context back-fill then
      // silently lands on the wrong row.
      turnUsageRepository.record({ ...base, inputTokens: 100, prefixTokens: 11_000 })
      turnUsageRepository.record({ ...base, inputTokens: 200, prefixTokens: 22_000 })

      const last = turnUsageRepository.getLastTurn(convId)
      assert.equal(last!.inputTokens, 200)
      assert.equal(last!.prefixTokens, 22_000)
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
