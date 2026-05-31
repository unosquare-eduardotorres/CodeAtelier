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
  cacheCreation = 0
): {
  tokenUsage: {
    input: number
    output: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
} {
  return {
    tokenUsage: {
      input,
      output,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation
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
