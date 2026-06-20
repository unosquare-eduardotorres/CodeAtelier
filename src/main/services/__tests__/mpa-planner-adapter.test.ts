/**
 * Unit tests for MpaPlannerAdapter — MPA planner phase adapter.
 *
 * Tests: constructor identity, getPhaseMessage branching (previousPlan + userFeedback),
 * inherited timeout, and buildPrompts guard.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { MpaPlannerAdapter } from '../role-adapters/mpa/mpa-planner.adapter'
import type { AdapterPromptContext } from '../agent-session.types'

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'hello',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

describe('MpaPlannerAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_mpa_planner', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-1', goal: 'Fix the bug' })
    assert.equal(adapter.role, 'mpa-planner')
  })

  test('agentId_includes_workspaceId', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-42', goal: 'Fix the bug' })
    assert.equal(adapter.agentId, 'mpa-planner-ws-42')
  })

  // ── Timeout ──

  test('inherits_30_min_timeout_from_MpaBaseAdapter', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-1', goal: 'Ship it' })
    assert.equal(adapter.interactionTimeoutMs, 30 * 60_000)
  })

  // ── getPhaseMessage branching ──

  test('getPhaseMessage_with_previousPlan_and_userFeedback_returns_revise', () => {
    const adapter = new MpaPlannerAdapter({
      workspaceId: 'ws-1',
      goal: 'Implement feature X',
      previousPlan: {
        contentJson: {
          phases: [],
          summary: 'old plan',
          planId: 'p1',
          estimatedEffort: 'medium',
          riskAssessment: 'low'
        }
      },
      userFeedback: 'Please add error handling'
    })
    // Access via buildPrompts after simulating onSessionStart by setting systemPrompt
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(result.effectiveMessage, 'Revise the plan based on the feedback above.')
  })

  test('getPhaseMessage_without_previousPlan_returns_investigate', () => {
    const adapter = new MpaPlannerAdapter({
      workspaceId: 'ws-1',
      goal: 'New feature'
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(
      result.effectiveMessage,
      'Investigate the codebase and produce your implementation plan.'
    )
  })

  test('getPhaseMessage_with_previousPlan_but_no_userFeedback_returns_investigate', () => {
    const adapter = new MpaPlannerAdapter({
      workspaceId: 'ws-1',
      goal: 'Feature Y',
      previousPlan: {
        contentJson: {
          phases: [],
          summary: 'old plan',
          planId: 'p1',
          estimatedEffort: 'medium',
          riskAssessment: 'low'
        }
      }
      // no userFeedback — both conditions needed for 'revise'
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(
      result.effectiveMessage,
      'Investigate the codebase and produce your implementation plan.'
    )
  })

  test('getPhaseMessage_with_userFeedback_but_no_previousPlan_returns_investigate', () => {
    const adapter = new MpaPlannerAdapter({
      workspaceId: 'ws-1',
      goal: 'Feature Z',
      userFeedback: 'Add tests'
      // no previousPlan
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(
      result.effectiveMessage,
      'Investigate the codebase and produce your implementation plan.'
    )
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-1', goal: 'Test' })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // ── Goal condition (inherited) ──

  test('goal_condition_roundtrip', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-1', goal: 'Test' })
    assert.equal(adapter.getGoalCondition(), null)
    adapter.setGoalCondition('Tests pass')
    assert.equal(adapter.getGoalCondition(), 'Tests pass')
  })

  // ── onSessionStop clears state ──

  test('onSessionStop_clears_goal_and_prompt', () => {
    const adapter = new MpaPlannerAdapter({ workspaceId: 'ws-1', goal: 'Test' })
    adapter.setGoalCondition('Tests pass')
    ;(adapter as any).systemPrompt = 'some prompt'
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
    assert.equal((adapter as any).systemPrompt, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
