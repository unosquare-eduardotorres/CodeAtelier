/**
 * Phase 27 — compaction-policy.ts pure function tests.
 *
 * All 5 exported functions are pure (no DB, no FS, no Electron).
 * Direct import + deterministic assertions.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import {
  canUseContext1MBeta,
  classifyCompaction,
  resolveCompactionThresholds,
  resolveAppliedThresholds,
  resolveClaudeCompactionEnv,
  resolveSdkContextWindowSize,
  type ClassifyCompactionInput
} from '../compaction-policy'

// ── helpers ──

function baseInput(overrides: Partial<ClassifyCompactionInput> = {}): ClassifyCompactionInput {
  return {
    inputTokens: 0,
    suggestThreshold: 100_000,
    autoThreshold: 150_000,
    isAutoCompactEnabled: false,
    compactSuggested: false,
    turnsSinceCompactSuggestion: 0,
    ...overrides
  }
}

// ── classifyCompaction ──

describe('classifyCompaction — band classification', () => {
  test('below 80% of suggestThreshold → no event, resets debounce', () => {
    const result = classifyCompaction(baseInput({ inputTokens: 50_000 }))
    assert.equal(result.level, null)
    assert.equal(result.nextSuggested, false)
    assert.equal(result.nextTurns, 0)
  })

  test('at 80% of suggestThreshold → warning (when not already suggesting)', () => {
    // 80% of 100_000 = 80_000
    const result = classifyCompaction(baseInput({ inputTokens: 80_000 }))
    assert.equal(result.level, 'warning')
  })

  test('at 80% of suggestThreshold → no event if already suggesting', () => {
    const result = classifyCompaction(baseInput({ inputTokens: 80_000, compactSuggested: true }))
    assert.equal(result.level, null)
  })

  test('above suggestThreshold → suggest on first occurrence', () => {
    const result = classifyCompaction(baseInput({ inputTokens: 110_000 }))
    assert.equal(result.level, 'suggest')
    assert.equal(result.nextSuggested, true)
    assert.equal(result.nextTurns, 0)
  })

  test('above suggestThreshold → debounced after first suggest (turns < 3)', () => {
    const result = classifyCompaction(
      baseInput({
        inputTokens: 110_000,
        compactSuggested: true,
        turnsSinceCompactSuggestion: 1
      })
    )
    assert.equal(result.level, null)
    assert.equal(result.nextTurns, 2) // incremented
  })

  test('above suggestThreshold → re-fires after 3 turns', () => {
    const result = classifyCompaction(
      baseInput({
        inputTokens: 110_000,
        compactSuggested: true,
        turnsSinceCompactSuggestion: 3
      })
    )
    assert.equal(result.level, 'suggest')
    assert.equal(result.nextTurns, 0) // reset
  })

  test('at/above the critical ceiling (1.2×auto) → critical despite auto-compact', () => {
    const result = classifyCompaction(
      baseInput({ inputTokens: 180_000, isAutoCompactEnabled: true })
    )
    assert.equal(result.level, 'critical')
  })

  test('above autoThreshold with auto-compact → auto-compact-pending', () => {
    const result = classifyCompaction(
      baseInput({ inputTokens: 160_000, isAutoCompactEnabled: true })
    )
    assert.equal(result.level, 'auto-compact-pending')
  })

  test('above autoThreshold without auto-compact → critical', () => {
    const result = classifyCompaction(
      baseInput({ inputTokens: 160_000, isAutoCompactEnabled: false })
    )
    assert.equal(result.level, 'critical')
  })

  test('exactly at suggestThreshold → suggest', () => {
    const result = classifyCompaction(baseInput({ inputTokens: 100_000 }))
    assert.equal(result.level, 'suggest')
  })

  test('exactly at autoThreshold → auto-compact-pending when enabled', () => {
    const result = classifyCompaction(
      baseInput({ inputTokens: 150_000, isAutoCompactEnabled: true })
    )
    assert.equal(result.level, 'auto-compact-pending')
  })

  test('zero tokens → reset debounce', () => {
    const result = classifyCompaction(
      baseInput({ inputTokens: 0, compactSuggested: true, turnsSinceCompactSuggestion: 5 })
    )
    assert.equal(result.level, null)
    assert.equal(result.nextSuggested, false)
    assert.equal(result.nextTurns, 0)
  })
})

// ── resolveCompactionThresholds ──

describe('resolveCompactionThresholds — window-based thresholds', () => {
  test('small window (≤200K) uses 0.6/0.75 ratios', () => {
    const result = resolveCompactionThresholds(200_000)
    assert.equal(result.suggest, 120_000) // 200K * 0.6
    assert.equal(result.auto, 150_000) // 200K * 0.75
  })

  test('large window (>200K) uses the same 0.6/0.75 ratios', () => {
    const result = resolveCompactionThresholds(1_000_000)
    assert.equal(result.suggest, 600_000) // 1M * 0.6
    assert.equal(result.auto, 750_000) // 1M * 0.75
  })

  test('no branch at the 200K boundary — 200_000 and 200_001 use identical ratios', () => {
    const large = resolveCompactionThresholds(200_001)
    // Same ratios on both sides of the old branch point (±1 token from rounding).
    assert.equal(large.suggest, Math.round(200_001 * 0.6))
    assert.equal(large.auto, Math.round(200_001 * 0.75))
    assert.ok(Math.abs(large.suggest - resolveCompactionThresholds(200_000).suggest) <= 1)
  })

  test('100K window → small ratios', () => {
    const result = resolveCompactionThresholds(100_000)
    assert.equal(result.suggest, 60_000)
    assert.equal(result.auto, 75_000)
  })
})

// ── resolveAppliedThresholds ──

describe('resolveAppliedThresholds — local vs Claude', () => {
  test('local provider uses TIER_LIMITS for small tier', () => {
    const result = resolveAppliedThresholds({ isLocal: true, localTier: 'small' })
    assert.ok(typeof result.suggest === 'number')
    assert.ok(typeof result.auto === 'number')
    assert.ok(result.suggest > 0)
    assert.ok(result.auto > result.suggest)
  })

  test('local provider uses TIER_LIMITS for large tier', () => {
    const result = resolveAppliedThresholds({ isLocal: true, localTier: 'large' })
    assert.ok(result.suggest > 0)
    assert.ok(result.auto > result.suggest)
  })

  test('local provider defaults to small tier when no tier specified', () => {
    const result = resolveAppliedThresholds({ isLocal: true })
    const smallResult = resolveAppliedThresholds({ isLocal: true, localTier: 'small' })
    assert.equal(result.suggest, smallResult.suggest)
    assert.equal(result.auto, smallResult.auto)
  })

  test('Claude provider derives from effective window (200K default)', () => {
    const result = resolveAppliedThresholds({ isLocal: false })
    const expected = resolveCompactionThresholds(200_000)
    assert.equal(result.suggest, expected.suggest)
    assert.equal(result.auto, expected.auto)
  })

  test('Claude provider uses user overrides when provided', () => {
    const result = resolveAppliedThresholds({
      isLocal: false,
      effectiveContextWindow: 1_000_000,
      userSuggestThreshold: 500_000,
      userAutoThreshold: 900_000
    })
    assert.equal(result.suggest, 500_000)
    assert.equal(result.auto, 900_000)
  })

  test('Claude provider uses defaults when no user overrides', () => {
    const result = resolveAppliedThresholds({
      isLocal: false,
      effectiveContextWindow: 1_000_000
    })
    assert.equal(result.suggest, 600_000) // 1M * 0.6
    assert.equal(result.auto, 750_000) // 1M * 0.75
  })
})

// ── resolveClaudeCompactionEnv ──

describe('resolveClaudeCompactionEnv — env var generation', () => {
  test('1M model sets window + 75% PCT override', () => {
    const env = resolveClaudeCompactionEnv(1_000_000)
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })

  test('non-1M model sets window + 75% PCT override', () => {
    const env = resolveClaudeCompactionEnv(200_000)
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })
})

// ── resolveSdkContextWindowSize ──

describe('resolveSdkContextWindowSize — SDK option', () => {
  test('1M model returns full window', () => {
    assert.equal(resolveSdkContextWindowSize(true, 1_000_000), 1_000_000)
  })

  test('non-1M model returns 80% of window', () => {
    assert.equal(resolveSdkContextWindowSize(false, 200_000), 160_000)
  })

  test('non-1M with 100K window', () => {
    assert.equal(resolveSdkContextWindowSize(false, 100_000), 80_000)
  })
})

// ── canUseContext1MBeta ──

describe('canUseContext1MBeta — API-only beta entitlement', () => {
  test('empty env (OAuth/subscription login) → false', () => {
    assert.equal(canUseContext1MBeta({}), false)
  })

  test('ANTHROPIC_API_KEY set → true', () => {
    assert.equal(canUseContext1MBeta({ ANTHROPIC_API_KEY: 'sk-ant-test' }), true)
  })

  test('blank ANTHROPIC_API_KEY does not count as a key', () => {
    assert.equal(canUseContext1MBeta({ ANTHROPIC_API_KEY: '   ' }), false)
  })

  test('CODE_ATELIER_CONTEXT_1M=1 forces on with no key', () => {
    assert.equal(canUseContext1MBeta({ CODE_ATELIER_CONTEXT_1M: '1' }), true)
  })

  test('CODE_ATELIER_CONTEXT_1M=0 forces off even with a key', () => {
    assert.equal(
      canUseContext1MBeta({ CODE_ATELIER_CONTEXT_1M: '0', ANTHROPIC_API_KEY: 'sk-ant-test' }),
      false
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
