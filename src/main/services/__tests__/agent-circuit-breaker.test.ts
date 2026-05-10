/**
 * Unit tests for AgentCircuitBreaker — tracks tool call count per interaction,
 * detects gratuitous tool use, and breaks the circuit at configurable limits.
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { createCircuitBreaker } from './helpers/agent-factory'

/** Helper: pump N tool calls through the breaker */
function pumpToolCalls(
  breaker: ReturnType<typeof createCircuitBreaker>['breaker'],
  n: number,
  opts?: { isBuildMode?: boolean; accumulatedTextLength?: number; conversationId?: string }
): void {
  for (let i = 0; i < n; i++) {
    breaker.onToolUse({
      isBuildMode: opts?.isBuildMode ?? false,
      accumulatedTextLength: opts?.accumulatedTextLength ?? 0,
      conversationId: opts?.conversationId ?? 'conv-test'
    })
  }
}

describe('AgentCircuitBreaker', () => {
  test('starts_with_zero_count_and_not_broken', () => {
    const { breaker } = createCircuitBreaker()
    assert.equal(breaker.count, 0)
    assert.equal(breaker.isBroken, false)
  })

  test('increments_count_on_each_onToolUse', () => {
    const { breaker } = createCircuitBreaker()
    breaker.onToolUse({ isBuildMode: false, accumulatedTextLength: 0, conversationId: 'c1' })
    assert.equal(breaker.count, 1)
    breaker.onToolUse({ isBuildMode: false, accumulatedTextLength: 0, conversationId: 'c1' })
    assert.equal(breaker.count, 2)
    breaker.onToolUse({ isBuildMode: false, accumulatedTextLength: 0, conversationId: 'c1' })
    assert.equal(breaker.count, 3)
  })

  test('returns_not_broken_for_normal_tool_use', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(result.broken, false)
    assert.equal(result.shouldTerminate, false)
    assert.equal(result.errorChunk, undefined)
  })

  test('detects_gratuitous_tool_use_when_500_chars_accumulated', () => {
    const { breaker } = createCircuitBreaker()
    // First tool call after 500+ chars of accumulated text → gratuitous detection
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 600,
      conversationId: 'c1'
    })
    assert.equal(result.shouldTerminate, true)
    assert.equal(result.broken, false, 'broken should be false for soft stop')
    assert.equal(breaker.isBroken, true, 'circuit should be marked broken internally')
  })

  test('does_not_trigger_gratuitous_on_second_tool_call', () => {
    const { breaker } = createCircuitBreaker()
    // First tool call with low text
    breaker.onToolUse({ isBuildMode: false, accumulatedTextLength: 0, conversationId: 'c1' })
    // Second tool call with high text — should NOT trigger gratuitous
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 600,
      conversationId: 'c1'
    })
    assert.equal(result.shouldTerminate, false)
    assert.equal(result.broken, false)
  })

  test('breaks_circuit_at_plan_mode_limit_50', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 49, { isBuildMode: false })
    assert.equal(breaker.isBroken, false)
    // 50th call triggers the break
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(result.broken, true)
    assert.equal(result.shouldTerminate, true)
    assert.ok(result.errorChunk, 'errorChunk should be present')
    assert.equal(result.errorChunk!.type, 'error')
    assert.equal(breaker.isBroken, true)
  })

  test('breaks_circuit_at_build_mode_limit_80', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 79, { isBuildMode: true })
    assert.equal(breaker.isBroken, false)
    // 80th call triggers the break
    const result = breaker.onToolUse({
      isBuildMode: true,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(result.broken, true)
    assert.equal(result.shouldTerminate, true)
    assert.ok(result.errorChunk, 'errorChunk should be present')
    assert.equal(breaker.isBroken, true)
  })

  test('error_message_differs_for_plan_vs_build', () => {
    const { breaker: planBreaker } = createCircuitBreaker()
    pumpToolCalls(planBreaker, 49, { isBuildMode: false })
    const planResult = planBreaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })

    const { breaker: buildBreaker } = createCircuitBreaker()
    pumpToolCalls(buildBreaker, 79, { isBuildMode: true })
    const buildResult = buildBreaker.onToolUse({
      isBuildMode: true,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })

    const planError = (planResult.errorChunk as { error: string }).error
    const buildError = (buildResult.errorChunk as { error: string }).error
    assert.ok(planError.includes('Build mode'), 'Plan error should mention Build mode')
    assert.ok(buildError.includes('smaller steps'), 'Build error should mention smaller steps')
    assert.notEqual(planError, buildError, 'Error messages should differ')
  })

  test('reset_clears_count_and_broken_state', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 50, { isBuildMode: false })
    assert.equal(breaker.isBroken, true)
    assert.equal(breaker.count, 50)
    breaker.reset()
    assert.equal(breaker.count, 0)
    assert.equal(breaker.isBroken, false)
  })

  test('does_not_break_at_limit_minus_one', () => {
    // Plan mode: 49 calls should NOT break
    const { breaker: planBreaker } = createCircuitBreaker()
    pumpToolCalls(planBreaker, 49, { isBuildMode: false })
    assert.equal(planBreaker.isBroken, false)
    assert.equal(planBreaker.count, 49)

    // Build mode: 79 calls should NOT break
    const { breaker: buildBreaker } = createCircuitBreaker()
    pumpToolCalls(buildBreaker, 79, { isBuildMode: true })
    assert.equal(buildBreaker.isBroken, false)
    assert.equal(buildBreaker.count, 79)
  })
})
