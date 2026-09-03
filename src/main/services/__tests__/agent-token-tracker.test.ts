/**
 * Unit tests for AgentTokenTracker — in-memory cache efficiency tracking,
 * per-turn cost breakdown, and session reset logic.
 *
 * Pure logic: DB path is skipped by passing dbSessionId: null.
 * No filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createTokenTracker } from './helpers/agent-factory'

/** Helper: creates a mock SDKExecuteResult with the given token usage */
function mockMeta(
  input: number,
  output: number,
  cacheRead = 0,
  cacheCreation = 0,
  firstCallContextTokens?: number
): {
  tokenUsage: {
    input: number
    output: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
    firstCallContextTokens?: number
  }
} {
  return {
    tokenUsage: {
      input,
      output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
      ...(firstCallContextTokens != null ? { firstCallContextTokens } : {})
    }
  }
}

/** Helper: default opts that skip DB path (dbSessionId: null) */
function defaultOpts(turnCount = 1) {
  return {
    turnCount,
    conversationId: 'conv-test',
    dbSessionId: null as string | null,
    workspacePath: '/test/workspace'
  }
}

describe('AgentTokenTracker — getCacheEfficiency', () => {
  test('getCacheEfficiency_returns_zeros_when_no_data', () => {
    const { tracker } = createTokenTracker()
    const report = tracker.getCacheEfficiency()
    assert.equal(report.hitRate, 0)
    assert.equal(report.savedTokens, 0)
    assert.equal(report.turns, 0)
    assert.equal(report.totalInput, 0)
    assert.deepEqual(report.turnBreakdown, [])
  })
})

describe('AgentTokenTracker — recordTurn', () => {
  test('recordTurn_accumulates_cache_stats', () => {
    const { tracker } = createTokenTracker()

    tracker.recordTurn(mockMeta(1000, 500, 200, 100) as any, defaultOpts(1))
    tracker.recordTurn(mockMeta(2000, 800, 400, 50) as any, defaultOpts(2))

    const report = tracker.getCacheEfficiency()
    assert.equal(report.turns, 2)
    assert.equal(report.totalInput, 3000) // 1000 + 2000
    assert.equal(report.savedTokens, 600) // 200 + 400 (cacheRead)
  })

  test('recordTurn_returns_total_tokens', () => {
    const { tracker } = createTokenTracker()
    const result = tracker.recordTurn(mockMeta(1000, 500, 0, 0) as any, defaultOpts(1))
    assert.equal(result.totalTokens, 1500, 'input + output = 1000 + 500')
  })
})

describe('AgentTokenTracker — getCacheEfficiency (computed)', () => {
  test('getCacheEfficiency_computes_hit_rate', () => {
    const { tracker } = createTokenTracker()

    // Turn 1: input=1000, cacheRead=500, cacheCreation=200
    // effectiveInput = input + cacheRead = 1000 + 500 = 1500
    // (cacheCreation excluded — it's a write cost, not input processing)
    tracker.recordTurn(mockMeta(1000, 300, 500, 200) as any, defaultOpts(1))

    const report = tracker.getCacheEfficiency()
    // hitRate = (cacheRead / effectiveInput) * 100 = (500 / 1500) * 100 ≈ 33.33
    const expectedRate = (500 / 1500) * 100
    assert.ok(
      Math.abs(report.hitRate - expectedRate) < 0.01,
      `hitRate should be ~${expectedRate.toFixed(2)}, got ${report.hitRate}`
    )
  })

  test('getCacheEfficiency_includes_turn_breakdown', () => {
    const { tracker } = createTokenTracker()

    tracker.recordTurn(mockMeta(1000, 500, 200, 100) as any, defaultOpts(1))
    tracker.recordTurn(mockMeta(2000, 800, 400, 50) as any, defaultOpts(2))
    tracker.recordTurn(mockMeta(3000, 1000, 600, 0) as any, defaultOpts(3))

    const report = tracker.getCacheEfficiency()
    assert.equal(report.turnBreakdown.length, 3, 'Should have one entry per recordTurn call')

    // Verify first turn breakdown
    assert.equal(report.turnBreakdown[0].inputTokens, 1000)
    assert.equal(report.turnBreakdown[0].outputTokens, 500)
    assert.equal(report.turnBreakdown[0].cacheReadTokens, 200)
    assert.equal(report.turnBreakdown[0].cacheCreationTokens, 100)

    // Verify third turn breakdown
    assert.equal(report.turnBreakdown[2].inputTokens, 3000)
    assert.equal(report.turnBreakdown[2].cacheReadTokens, 600)
  })
})

describe('AgentTokenTracker — usage_log dual-write', () => {
  let dbAvailable = false
  let createTestDb: typeof import('../../db/test-helpers').createTestDb
  let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
  let usageLogRepository: typeof import('../../db/repositories/usage-log.repository').usageLogRepository
  try {
    createTestDb = require('../../db/test-helpers').createTestDb
    _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
    usageLogRepository = require('../../db/repositories/usage-log.repository').usageLogRepository
    const probe = createTestDb()
    probe.close()
    dbAvailable = true
  } catch {
    dbAvailable = false
  }

  test(
    'recordTurn writes usage_log with the real model + feature',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      tracker.recordTurn(mockMeta(1000, 500, 0, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-dual',
        dbSessionId: null,
        workspacePath: '/test/workspace',
        feature: 'grill',
        agentType: 'grill-agent',
        model: 'claude-opus-4-8',
        workspaceId: 'ws-1'
      })

      const summary = usageLogRepository.getWorkspaceSummary('ws-1')
      assert.equal(summary.byFeature.length, 1)
      assert.equal(summary.byFeature[0].feature, 'grill', 'feature is recorded, not hardcoded chat')
      assert.equal(summary.totalInput, 1000)
      assert.equal(summary.totalOutput, 500)
      // opus 4.8 = $5/1M in, $25/1M out → (1000/1e6*5 + 500/1e6*25)*100 = 1.75 → round 2 cents
      assert.equal(summary.totalCostCents, 2)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  let turnUsageRepository: typeof import('../../db/repositories/turn-usage.repository').turnUsageRepository
  if (dbAvailable) {
    turnUsageRepository = require('../../db/repositories/turn-usage.repository').turnUsageRepository
  }

  test(
    'recordTurn writes attribution to both usage_log and turn_usage',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      tracker.recordTurn(mockMeta(1000, 500, 0, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-attr',
        dbSessionId: 'sess-attr',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        agentType: 'blueprint-build-bp-1',
        model: 'claude-opus-4-8',
        workspaceId: 'ws-attr',
        provider: 'opencode',
        blueprintId: 'bp-1',
        taskId: 'T3',
        attempt: 2
      })

      const turns = turnUsageRepository.findByConversation('conv-attr')
      assert.equal(turns.length, 1)
      assert.equal(turns[0].provider, 'opencode')
      assert.equal(turns[0].blueprintId, 'bp-1')
      assert.equal(turns[0].taskId, 'T3')
      assert.equal(turns[0].attempt, 2)

      const logId = (
        require('../../db/index')
          .getDatabase()
          .prepare(`SELECT id FROM usage_log WHERE workspace_id = ?`)
          .get('ws-attr') as { id: string }
      ).id
      const logEntry = usageLogRepository.findById(logId)
      assert.ok(logEntry)
      // `model` cannot answer "which backend served this" — OpenCode serves
      // Claude-named models, so the provider column is the only reliable source.
      assert.equal(logEntry.model, 'claude-opus-4-8')
      assert.equal(logEntry.provider, 'opencode')
      assert.equal(logEntry.blueprintId, 'bp-1')
      assert.equal(logEntry.taskId, 'T3')
      assert.equal(logEntry.attempt, 2)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'recordTurn leaves attribution NULL for non-blueprint features',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      tracker.recordTurn(mockMeta(1000, 500, 0, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-plain',
        dbSessionId: 'sess-plain',
        workspacePath: '/test/workspace',
        feature: 'chat',
        model: 'claude-opus-4-8',
        workspaceId: 'ws-plain'
      })

      const turns = turnUsageRepository.findByConversation('conv-plain')
      assert.equal(turns.length, 1, 'a real turn is still recorded')
      assert.equal(turns[0].provider, null)
      assert.equal(turns[0].blueprintId, null)
      assert.equal(turns[0].taskId, null)
      assert.equal(turns[0].attempt, null)

      // Nothing else regresses: feature + cost attribution is unchanged.
      const summary = usageLogRepository.getWorkspaceSummary('ws-plain')
      assert.equal(summary.byFeature[0].feature, 'chat')
      assert.equal(summary.totalCostCents, 2)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'recordTurn skips turn_usage for an all-zero meta chunk',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      tracker.recordTurn(mockMeta(0, 0, 0, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-zero',
        dbSessionId: 'sess-zero',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        model: 'claude-opus-4-8',
        workspaceId: 'ws-zero'
      })

      // A zero-usage row could never receive context_tokens (the stream
      // processor's backfill is guarded on > 0 and only targets the latest
      // turn), so it was a permanent hole in the Gate T denominator.
      assert.equal(
        turnUsageRepository.findByConversation('conv-zero').length,
        0,
        'no analytics row is created for a turn that consumed nothing'
      )

      // usage_log is the cost ledger and still sees the turn.
      const summary = usageLogRepository.getWorkspaceSummary('ws-zero')
      assert.equal(summary.byFeature.length, 1)
      assert.equal(summary.byFeature[0].calls, 1)

      // The caller must be told no row exists, or its context-token back-fill
      // lands on the previous turn.
      const res = tracker.recordTurn(mockMeta(0, 0, 0, 0) as any, {
        turnCount: 2,
        conversationId: 'conv-zero',
        dbSessionId: 'sess-zero',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        workspaceId: 'ws-zero'
      })
      assert.equal(res.turnRecorded, false)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'a zero-usage turn cannot overwrite the previous turn context_tokens',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()
      const opts = (turnCount: number) => ({
        turnCount,
        conversationId: 'conv-ctx',
        dbSessionId: 'sess-ctx',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        workspaceId: 'ws-ctx'
      })

      // Turn 1 is real and carries a measured context size.
      const first = tracker.recordTurn(mockMeta(5000, 200, 0, 0) as any, opts(1))
      assert.equal(first.turnRecorded, true)
      turnUsageRepository.updateLastTurnContextTokens('conv-ctx', 103_527)

      // Turn 2 reports all-zero usage. A result message can zero the token
      // fields while `contextWindowTokens` keeps a stale non-zero snapshot, so
      // the stream processor would still compute totalContextTokens > 0 and
      // back-fill — onto turn 1, the only row there is.
      const second = tracker.recordTurn(mockMeta(0, 0, 0, 0) as any, opts(2))
      assert.equal(second.turnRecorded, false, 'caller is told not to back-fill')

      // Simulate the caller honouring the flag.
      if (second.turnRecorded) {
        turnUsageRepository.updateLastTurnContextTokens('conv-ctx', 120_354)
      }

      const turns = turnUsageRepository.findByConversation('conv-ctx')
      assert.equal(turns.length, 1)
      assert.equal(
        turns[0].contextTokens,
        103_527,
        "turn 1's measured context survives the zero-usage turn"
      )
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'recordTurn still records a turn when only cache tokens are non-zero',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      // A fully-cached round-trip reports input=0/output=0 but real cache reads.
      // That is a real turn and must not be swept up by the zero-usage guard.
      tracker.recordTurn(mockMeta(0, 0, 4000, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-cached',
        dbSessionId: 'sess-cached',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        model: 'claude-opus-4-8',
        workspaceId: 'ws-cached'
      })

      const turns = turnUsageRepository.findByConversation('conv-cached')
      assert.equal(turns.length, 1)
      assert.equal(turns[0].cacheReadTokens, 4000)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  // ── prefix_tokens ──
  //
  // The invariant prefix (first round-trip prompt size) is written HERE, at
  // INSERT, because the meta chunk that carries it is already in hand. It is a
  // different quantity from context_tokens, which the stream processor
  // back-fills from the LAST round-trip.

  test(
    'the first-call prefix is stored on the row it belongs to',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      // A real blueprint task: 22 input tokens against a 1M cache read, because
      // ~10 round-trips each re-read the whole context. The prefix is what the
      // FIRST of those calls sent.
      tracker.recordTurn(mockMeta(22, 500, 1_014_653, 0, 28_400) as any, {
        turnCount: 1,
        conversationId: 'conv-prefix',
        dbSessionId: 'sess-prefix',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        workspaceId: 'ws-prefix',
        blueprintId: 'bp-1',
        taskId: 'T3'
      })

      const turns = turnUsageRepository.findByConversation('conv-prefix')
      assert.equal(turns.length, 1)
      assert.equal(turns[0].prefixTokens, 28_400)
      assert.equal(turns[0].cacheReadTokens, 1_014_653, 'cache data untouched')
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )

  test(
    'a backend with no per-call snapshot stores NULL, never the summed total',
    () => {
      if (!dbAvailable) return
      _setDatabaseForTesting(createTestDb())
      const { tracker } = createTokenTracker()

      // OpenCode only accumulates totals. Deriving a prefix from them would
      // store 1,014,675 — a ~30x over-count that averages in silently. NULL can
      // be filtered out of an average; a wrong number cannot.
      tracker.recordTurn(mockMeta(22, 500, 1_014_653, 0) as any, {
        turnCount: 1,
        conversationId: 'conv-opencode',
        dbSessionId: 'sess-opencode',
        workspacePath: '/test/workspace',
        feature: 'blueprint-build',
        workspaceId: 'ws-opencode',
        provider: 'glm',
        blueprintId: 'bp-2',
        taskId: 'T1'
      })

      const turns = turnUsageRepository.findByConversation('conv-opencode')
      assert.equal(turns.length, 1)
      assert.equal(turns[0].prefixTokens, null)
    },
    dbAvailable ? undefined : { skipReason: 'no DB' }
  )
})

describe('AgentTokenTracker — reset & resetSession', () => {
  test('resetSession_clears_all_stats', () => {
    const { tracker } = createTokenTracker()

    tracker.recordTurn(mockMeta(1000, 500, 200, 100) as any, defaultOpts(1))
    assert.equal(tracker.getCacheEfficiency().turns, 1, 'Pre-condition: 1 turn recorded')

    tracker.resetSession()

    const report = tracker.getCacheEfficiency()
    assert.equal(report.hitRate, 0)
    assert.equal(report.savedTokens, 0)
    assert.equal(report.turns, 0)
    assert.equal(report.totalInput, 0)
    assert.deepEqual(report.turnBreakdown, [])
  })

  test('reset_does_not_clear_session_stats', () => {
    const { tracker } = createTokenTracker()

    tracker.recordTurn(mockMeta(1000, 500, 200, 100) as any, defaultOpts(1))
    assert.equal(tracker.getCacheEfficiency().turns, 1, 'Pre-condition: 1 turn recorded')

    // reset() is a no-op for cache stats (by design — they accumulate across session)
    tracker.reset()

    const report = tracker.getCacheEfficiency()
    assert.equal(report.turns, 1, 'Cache stats should persist after reset()')
    assert.equal(report.totalInput, 1000, 'totalInput should persist after reset()')
  })

  test('recordTurn_handles_zero_cache_tokens', () => {
    const { tracker } = createTokenTracker()

    tracker.recordTurn(mockMeta(1000, 500, 0, 0) as any, defaultOpts(1))

    const report = tracker.getCacheEfficiency()
    assert.equal(report.turns, 1)
    // cacheHitRate in breakdown should be 0 when all cache tokens are 0
    // effectiveInput = 1000 + 0 = 1000, cacheRead = 0 → hitRate = 0
    assert.equal(
      report.turnBreakdown[0].cacheHitRate,
      0,
      'cacheHitRate should be 0 with no cache tokens'
    )
  })
})
