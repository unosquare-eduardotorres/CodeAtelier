/**
 * Run 17: Compaction policy — threshold resolution + band classification.
 *
 * Guards the pure helpers extracted into compaction-policy.ts:
 *   - resolveCompactionThresholds (window → suggest/auto)
 *   - resolveAppliedThresholds (local tier table vs Claude window + user overrides)
 *   - classifyCompaction (the debounced warning/suggest/critical band machine)
 *   - resolveClaudeCompactionEnv / resolveSdkContextWindowSize (CLI compaction wiring)
 *
 * These were previously inline in AgentStreamProcessor.checkCompaction and could
 * only be exercised through a live SDK stream — now they're deterministic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  resolveCompactionThresholds,
  resolveAppliedThresholds,
  classifyCompaction,
  resolveClaudeCompactionEnv,
  resolveSdkContextWindowSize
} from '../compaction-policy'
import { TIER_LIMITS } from '../context-management'

describe('resolveCompactionThresholds', () => {
  test('1M window → suggest=700K (0.7), auto=850K (0.85)', () => {
    assert.deepEqual(resolveCompactionThresholds(1_000_000), { suggest: 700_000, auto: 850_000 })
  })

  test('200K window → suggest=120K (0.6), auto=150K (0.75)', () => {
    assert.deepEqual(resolveCompactionThresholds(200_000), { suggest: 120_000, auto: 150_000 })
  })

  test('boundary at exactly 200K is treated as small window', () => {
    const { suggest } = resolveCompactionThresholds(200_000)
    assert.equal(suggest, 120_000) // 0.6, not 0.7
  })
})

describe('resolveAppliedThresholds — local providers use the tier table', () => {
  test('small tier picks TIER_LIMITS.small', () => {
    const r = resolveAppliedThresholds({ isLocal: true, localTier: 'small' })
    assert.equal(r.suggest, TIER_LIMITS.small.compactSuggestThreshold)
    assert.equal(r.auto, TIER_LIMITS.small.compactAutoThreshold)
    assert.equal(r.suggest, 16_000)
    assert.equal(r.auto, 24_000)
  })

  test('medium tier picks TIER_LIMITS.medium', () => {
    const r = resolveAppliedThresholds({ isLocal: true, localTier: 'medium' })
    assert.equal(r.suggest, TIER_LIMITS.medium.compactSuggestThreshold)
    assert.equal(r.auto, TIER_LIMITS.medium.compactAutoThreshold)
  })

  test('large tier picks TIER_LIMITS.large', () => {
    const r = resolveAppliedThresholds({ isLocal: true, localTier: 'large' })
    assert.equal(r.suggest, TIER_LIMITS.large.compactSuggestThreshold)
    assert.equal(r.auto, TIER_LIMITS.large.compactAutoThreshold)
  })
})

describe('resolveAppliedThresholds — Claude derives from window, user overrides win', () => {
  test('1M window with no overrides → 700K / 850K', () => {
    const r = resolveAppliedThresholds({ isLocal: false, effectiveContextWindow: 1_000_000 })
    assert.deepEqual(r, { suggest: 700_000, auto: 850_000 })
  })

  test('200K window with no overrides → 120K / 150K', () => {
    const r = resolveAppliedThresholds({ isLocal: false, effectiveContextWindow: 200_000 })
    assert.deepEqual(r, { suggest: 120_000, auto: 150_000 })
  })

  test('user thresholds take precedence over derived defaults', () => {
    const r = resolveAppliedThresholds({
      isLocal: false,
      effectiveContextWindow: 1_000_000,
      userSuggestThreshold: 333_000,
      userAutoThreshold: 444_000
    })
    assert.deepEqual(r, { suggest: 333_000, auto: 444_000 })
  })

  test('a single user override only replaces that one threshold', () => {
    const r = resolveAppliedThresholds({
      isLocal: false,
      effectiveContextWindow: 200_000,
      userSuggestThreshold: 90_000
    })
    assert.equal(r.suggest, 90_000)
    assert.equal(r.auto, 150_000) // still derived
  })
})

describe('classifyCompaction — band table', () => {
  // suggest=100, auto=150 → warning band starts at floor(100*0.8)=80
  const S = 100
  const A = 150

  test('below warning resets debounce state and emits nothing', () => {
    const r = classifyCompaction({
      inputTokens: 50,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: true,
      turnsSinceCompactSuggestion: 2
    })
    assert.equal(r.level, null)
    assert.equal(r.nextSuggested, false)
    assert.equal(r.nextTurns, 0)
  })

  test('warning band emits warning when not already suggesting', () => {
    const r = classifyCompaction({
      inputTokens: 85,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: false,
      turnsSinceCompactSuggestion: 0
    })
    assert.equal(r.level, 'warning')
  })

  test('warning band is silent once a suggest has already fired', () => {
    const r = classifyCompaction({
      inputTokens: 85,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: true,
      turnsSinceCompactSuggestion: 1
    })
    assert.equal(r.level, null)
    // state preserved (not reset — still above warning floor)
    assert.equal(r.nextSuggested, true)
    assert.equal(r.nextTurns, 1)
  })

  test('suggest band emits suggest the first time', () => {
    const r = classifyCompaction({
      inputTokens: 120,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: false,
      turnsSinceCompactSuggestion: 0
    })
    assert.equal(r.level, 'suggest')
    assert.equal(r.nextSuggested, true)
    assert.equal(r.nextTurns, 0)
  })

  test('suggest band is debounced for the next 2 turns, then re-fires on the 3rd', () => {
    // turn after first suggest
    const t1 = classifyCompaction({
      inputTokens: 120,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: true,
      turnsSinceCompactSuggestion: 0
    })
    assert.equal(t1.level, null)
    assert.equal(t1.nextTurns, 1)

    const t2 = classifyCompaction({
      inputTokens: 120,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: true,
      turnsSinceCompactSuggestion: 1
    })
    assert.equal(t2.level, null)
    assert.equal(t2.nextTurns, 2)

    // 3rd turn (turnsSince >= 3) re-fires
    const t3 = classifyCompaction({
      inputTokens: 120,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: true,
      turnsSinceCompactSuggestion: 3
    })
    assert.equal(t3.level, 'suggest')
    assert.equal(t3.nextTurns, 0)
  })

  test('auto band with auto-compact ENABLED → auto-compact-pending', () => {
    const r = classifyCompaction({
      inputTokens: 200,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: true,
      compactSuggested: false,
      turnsSinceCompactSuggestion: 0
    })
    assert.equal(r.level, 'auto-compact-pending')
  })

  test('auto band with auto-compact DISABLED → critical', () => {
    const r = classifyCompaction({
      inputTokens: 200,
      suggestThreshold: S,
      autoThreshold: A,
      isAutoCompactEnabled: false,
      compactSuggested: false,
      turnsSinceCompactSuggestion: 0
    })
    assert.equal(r.level, 'critical')
  })
})

describe('resolveClaudeCompactionEnv — CLI compaction wiring', () => {
  test('1M model sets the window to 1000000 and no pct override', () => {
    const env = resolveClaudeCompactionEnv(true, 1_000_000)
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined)
  })

  test('200K model sets window=200000 and pct override=80', () => {
    const env = resolveClaudeCompactionEnv(false, 200_000)
    assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    assert.equal(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80')
  })
})

describe('resolveSdkContextWindowSize', () => {
  test('1M model passes the full window', () => {
    assert.equal(resolveSdkContextWindowSize(true, 1_000_000), 1_000_000)
  })

  test('200K model passes 80% (160000)', () => {
    assert.equal(resolveSdkContextWindowSize(false, 200_000), 160_000)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
