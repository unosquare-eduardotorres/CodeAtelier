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

  // Regression: on an auto-continuation the caller rebases its text measure to the
  // start of the new turn, so the first tool call sees 0 and must NOT be soft-stopped.
  // Without this, a continuation whose pre-break turn wrote 500+ chars was killed by
  // the stream-cut in agent-session.service before doing any work.
  test('does_not_soft_stop_first_tool_call_when_turn_scoped_length_is_zero', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c-continuation'
    })
    assert.equal(result.shouldTerminate, false)
    assert.equal(result.broken, false)
    assert.equal(breaker.isBroken, false, 'continuation must not be cut on its first tool call')
  })

  test('still_soft_stops_first_tool_call_when_turn_wrote_1699_chars', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 1699,
      conversationId: 'c-uncontinued'
    })
    assert.equal(result.shouldTerminate, true)
    assert.equal(breaker.isBroken, true)
  })

  // Regression: in build mode "write a paragraph, then act" is the normal rhythm.
  // The heuristic read a 1219-char status recap as a finished answer and cut the
  // stream on the very next tool call, orphaning a test run that had already started.
  test('does_not_soft_stop_in_build_mode_after_a_long_recap', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: true,
      accumulatedTextLength: 1699,
      conversationId: 'c-build'
    })
    assert.equal(result.shouldTerminate, false)
    assert.equal(result.broken, false)
    assert.equal(breaker.isBroken, false, 'build mode must not be cut on its first tool call')
  })

  test('still_soft_stops_in_plan_mode_with_the_same_inputs', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 1699,
      conversationId: 'c-plan'
    })
    assert.equal(result.shouldTerminate, true)
    assert.equal(breaker.isBroken, true)
  })

  // CB-GOAL-01 regression (map sessions): a goal-conditioned plan session
  // legitimately streams analysis prose before its FIRST tool call — the
  // gratuitous heuristic must stay suppressed. Live: blueprint map sessions
  // were cut at the first read tool (4/4 docs 'no parseable tasks').
  test('does_not_soft_stop_first_tool_call_when_goal_condition_is_active', () => {
    const { breaker } = createCircuitBreaker()
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 27223,
      conversationId: 'conv-map-1',
      hasGoalCondition: true
    })
    assert.equal(result.broken, false)
    assert.equal(result.shouldTerminate, false)
    assert.equal(breaker.isBroken, false)
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

  test('breaks_circuit_at_plan_mode_limit_250_with_continuable_break', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 249, { isBuildMode: false })
    assert.equal(breaker.isBroken, false)
    // 250th call triggers the break
    const result = breaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(result.broken, true)
    assert.equal(result.shouldTerminate, true)
    assert.equal(result.isContinuableBreak, true, 'should be a continuable break, not a hard error')
    assert.equal(breaker.isBroken, true)
  })

  test('breaks_circuit_at_build_mode_limit_400_with_continuable_break', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 399, { isBuildMode: true })
    assert.equal(breaker.isBroken, false)
    // 400th call triggers the break
    const result = breaker.onToolUse({
      isBuildMode: true,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(result.broken, true)
    assert.equal(result.shouldTerminate, true)
    assert.equal(result.isContinuableBreak, true, 'should be a continuable break, not a hard error')
    assert.equal(breaker.isBroken, true)
  })

  test('all_circuit_breaks_are_continuable_no_error_chunks', () => {
    // Plan mode break
    const { breaker: planBreaker } = createCircuitBreaker()
    pumpToolCalls(planBreaker, 249, { isBuildMode: false })
    const planResult = planBreaker.onToolUse({
      isBuildMode: false,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(planResult.isContinuableBreak, true)

    // Build mode break
    const { breaker: buildBreaker } = createCircuitBreaker()
    pumpToolCalls(buildBreaker, 399, { isBuildMode: true })
    const buildResult = buildBreaker.onToolUse({
      isBuildMode: true,
      accumulatedTextLength: 0,
      conversationId: 'c1'
    })
    assert.equal(buildResult.isContinuableBreak, true)
  })

  test('reset_clears_count_and_broken_state', () => {
    const { breaker } = createCircuitBreaker()
    pumpToolCalls(breaker, 250, { isBuildMode: false })
    assert.equal(breaker.isBroken, true)
    assert.equal(breaker.count, 250)
    breaker.reset()
    assert.equal(breaker.count, 0)
    assert.equal(breaker.isBroken, false)
  })

  test('does_not_break_at_limit_minus_one', () => {
    // Plan mode: 249 calls should NOT break
    const { breaker: planBreaker } = createCircuitBreaker()
    pumpToolCalls(planBreaker, 249, { isBuildMode: false })
    assert.equal(planBreaker.isBroken, false)
    assert.equal(planBreaker.count, 249)

    // Build mode: 399 calls should NOT break
    const { breaker: buildBreaker } = createCircuitBreaker()
    pumpToolCalls(buildBreaker, 399, { isBuildMode: true })
    assert.equal(buildBreaker.isBroken, false)
    assert.equal(buildBreaker.count, 399)
  })

  // Regression: the 80% "early warning" used to return an `additionalContext`
  // string addressed to the model. Its only consumer rendered it to the HUMAN as
  // a blockquote — it never entered the model's context. It is now log-only, and
  // no result may carry that field again without a real injection path.
  test('no_result_ever_carries_additionalContext', () => {
    for (const isBuildMode of [true, false]) {
      for (const isLocalProvider of [true, false]) {
        const { breaker } = createCircuitBreaker()
        for (let i = 0; i < 420; i++) {
          const result = breaker.onToolUse({
            isBuildMode,
            accumulatedTextLength: 0,
            conversationId: 'c-budget',
            isLocalProvider,
            contextTier: isLocalProvider ? 'large' : undefined
          })
          assert.equal(
            (result as unknown as Record<string, unknown>).additionalContext,
            undefined,
            `call ${i + 1} (build=${isBuildMode} local=${isLocalProvider}) must not carry additionalContext`
          )
          if (result.broken) break
        }
      }
    }
  })
})
