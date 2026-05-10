/**
 * Tests for context management configuration module.
 *
 * Covers:
 * - CLAUDE_1M_CONTEXT_CONFIG threshold values
 * - CLAUDE_ECONOMY_CONTEXT_CONFIG lower bounds
 * - getLocalLlmContextConfig scaling
 * - Memory tool exclusion lists
 * - Context window tier system (resolveContextTier, TIER_LIMITS)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  CLAUDE_1M_CONTEXT_CONFIG,
  CLAUDE_ECONOMY_CONTEXT_CONFIG,
  getLocalLlmContextConfig,
  resolveContextTier,
  TIER_LIMITS
} from '../context-management'

describe('Context Management Config', () => {
  test('1M config has correct trigger thresholds', () => {
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsTrigger, 300_000)
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.serverCompactionTrigger, 600_000)
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsKeep, 5)
  })

  test('1M config enables all three tiers', () => {
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.clearToolResults, true)
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.clearThinking, true)
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG.serverCompaction, true)
  })

  test('1M config has compaction instructions', () => {
    assert.ok(CLAUDE_1M_CONTEXT_CONFIG.compactionInstructions)
    assert.ok(CLAUDE_1M_CONTEXT_CONFIG.compactionInstructions!.includes('Preserve'))
    assert.ok(CLAUDE_1M_CONTEXT_CONFIG.compactionInstructions!.includes('Discard'))
  })

  test('economy config has lower thresholds than 1M', () => {
    assert.ok(
      CLAUDE_ECONOMY_CONTEXT_CONFIG.clearToolResultsTrigger <
        CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsTrigger
    )
    assert.ok(
      CLAUDE_ECONOMY_CONTEXT_CONFIG.serverCompactionTrigger <
        CLAUDE_1M_CONTEXT_CONFIG.serverCompactionTrigger
    )
  })

  test('economy config keeps fewer tool results', () => {
    assert.ok(
      CLAUDE_ECONOMY_CONTEXT_CONFIG.clearToolResultsKeep <
        CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsKeep
    )
  })

  test('economy config keeps fewer thinking turns', () => {
    assert.ok(
      CLAUDE_ECONOMY_CONTEXT_CONFIG.clearThinkingKeepTurns <
        CLAUDE_1M_CONTEXT_CONFIG.clearThinkingKeepTurns
    )
  })

  test('local LLM config scales with window size', () => {
    const small = getLocalLlmContextConfig(32_768)
    const large = getLocalLlmContextConfig(262_144)
    assert.ok(small.clearToolResultsTrigger < large.clearToolResultsTrigger)
    assert.ok(small.clearToolResultsMinClear < large.clearToolResultsMinClear)
  })

  test('local LLM config disables server-side features', () => {
    const config = getLocalLlmContextConfig(32_768)
    assert.equal(config.serverCompaction, false)
    assert.equal(config.clearThinking, false)
    assert.equal(config.serverCompactionTrigger, 0)
  })

  test('local LLM config has proportional thresholds', () => {
    const config = getLocalLlmContextConfig(100_000)
    // 30% of 100K = 30K
    assert.equal(config.clearToolResultsTrigger, 30_000)
    // 5% of 100K = 5K
    assert.equal(config.clearToolResultsMinClear, 5_000)
  })

  test('memory tools are excluded from clearing in Claude configs', () => {
    assert.ok(CLAUDE_1M_CONTEXT_CONFIG.clearToolResultsExclude.some((t) => t.includes('memory')))
    assert.ok(
      CLAUDE_ECONOMY_CONTEXT_CONFIG.clearToolResultsExclude.some((t) => t.includes('memory'))
    )
  })

  test('local LLM config has empty exclusion list', () => {
    const config = getLocalLlmContextConfig(32_768)
    assert.equal(config.clearToolResultsExclude.length, 0)
  })

  test('local LLM small tier keeps fewer tool results', () => {
    const config = getLocalLlmContextConfig(32_768)
    assert.equal(config.clearToolResultsKeep, 2)
  })

  test('local LLM medium/large tier keeps 3 tool results', () => {
    const medium = getLocalLlmContextConfig(128_000)
    const large = getLocalLlmContextConfig(262_144)
    assert.equal(medium.clearToolResultsKeep, 3)
    assert.equal(large.clearToolResultsKeep, 3)
  })
})

describe('Context Window Tiers', () => {
  test('resolves tier from context window size', () => {
    assert.equal(resolveContextTier(32_768), 'small')
    assert.equal(resolveContextTier(65_536), 'small')
    assert.equal(resolveContextTier(65_537), 'medium')
    assert.equal(resolveContextTier(128_000), 'medium')
    assert.equal(resolveContextTier(131_072), 'medium')
    assert.equal(resolveContextTier(131_073), 'large')
    assert.equal(resolveContextTier(262_144), 'large')
  })

  test('small tier has proportionally lower limits than medium', () => {
    assert.ok(TIER_LIMITS.small.maxTurnsBuild < TIER_LIMITS.medium.maxTurnsBuild)
    assert.ok(TIER_LIMITS.small.maxTurnsPlan < TIER_LIMITS.medium.maxTurnsPlan)
    assert.ok(TIER_LIMITS.small.readLineLimit < TIER_LIMITS.medium.readLineLimit)
    assert.ok(TIER_LIMITS.small.toolResultBudgetChars < TIER_LIMITS.medium.toolResultBudgetChars)
  })

  test('medium tier has proportionally lower limits than large', () => {
    assert.ok(TIER_LIMITS.medium.maxTurnsBuild < TIER_LIMITS.large.maxTurnsBuild)
    assert.ok(TIER_LIMITS.medium.readLineLimit < TIER_LIMITS.large.readLineLimit)
    assert.ok(TIER_LIMITS.medium.toolResultBudgetChars < TIER_LIMITS.large.toolResultBudgetChars)
  })

  test('large tier matches Claude-like defaults', () => {
    assert.equal(TIER_LIMITS.large.maxTurnsPlan, 30)
    assert.equal(TIER_LIMITS.large.maxTurnsBuild, 50)
    assert.equal(TIER_LIMITS.large.readLineLimit, 300)
    assert.equal(TIER_LIMITS.large.toolResultBudgetChars, 200_000)
  })

  test('small tier has conservative limits for 32K window', () => {
    assert.equal(TIER_LIMITS.small.maxTurnsBuild, 12)
    assert.equal(TIER_LIMITS.small.maxTurnsPlan, 8)
    assert.equal(TIER_LIMITS.small.readLineLimit, 100)
    assert.equal(TIER_LIMITS.small.toolResultBudgetChars, 30_000)
  })

  test('compaction thresholds increase with tier', () => {
    assert.ok(TIER_LIMITS.small.compactSuggestThreshold < TIER_LIMITS.medium.compactSuggestThreshold)
    assert.ok(TIER_LIMITS.medium.compactSuggestThreshold < TIER_LIMITS.large.compactSuggestThreshold)
    assert.ok(TIER_LIMITS.small.compactAutoThreshold < TIER_LIMITS.medium.compactAutoThreshold)
    assert.ok(TIER_LIMITS.medium.compactAutoThreshold < TIER_LIMITS.large.compactAutoThreshold)
  })

  test('getLocalLlmContextConfig attaches tier limits for small window', () => {
    const config = getLocalLlmContextConfig(32_768)
    assert.ok(config._tierLimits)
    assert.equal(config._tier, 'small')
    assert.equal(config._tierLimits!.maxTurnsBuild, 12)
    assert.equal(config._tierLimits!.readLineLimit, 100)
    assert.equal(config._tierLimits!.toolResultBudgetChars, 30_000)
  })

  test('getLocalLlmContextConfig attaches tier limits for medium window', () => {
    const config = getLocalLlmContextConfig(128_000)
    assert.equal(config._tier, 'medium')
    assert.equal(config._tierLimits!.maxTurnsBuild, 25)
  })

  test('262K model gets large tier with full limits', () => {
    const config = getLocalLlmContextConfig(262_144)
    assert.equal(config._tier, 'large')
    assert.equal(config._tierLimits!.maxTurnsPlan, 30)
    assert.equal(config._tierLimits!.maxTurnsBuild, 50)
    assert.equal(config._tierLimits!.readLineLimit, 300)
    assert.equal(config._tierLimits!.toolResultBudgetChars, 200_000)
  })

  test('Claude configs do NOT have tier metadata', () => {
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG._tier, undefined)
    assert.equal(CLAUDE_1M_CONTEXT_CONFIG._tierLimits, undefined)
    assert.equal(CLAUDE_ECONOMY_CONTEXT_CONFIG._tier, undefined)
    assert.equal(CLAUDE_ECONOMY_CONTEXT_CONFIG._tierLimits, undefined)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
