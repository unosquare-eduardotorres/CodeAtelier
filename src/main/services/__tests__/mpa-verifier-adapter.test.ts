/**
 * Unit tests for MpaVerifierAdapter — MPA verifier phase adapter.
 *
 * Tests: constructor identity, getPhaseMessage, inherited readonly MCP config,
 * buildPrompts guard, and inherited goal condition lifecycle.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { MpaVerifierAdapter } from '../role-adapters/mpa/mpa-verifier.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'verify',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/verify-test',
    workspaceId: 'ws-v1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('MpaVerifierAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_mpa_verifier', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify implementation',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    assert.equal(adapter.role, 'mpa-verifier')
  })

  test('agentId_includes_workspaceId', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-99',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    assert.equal(adapter.agentId, 'mpa-verifier-ws-99')
  })

  // ── getPhaseMessage ──

  test('getPhaseMessage_returns_verification_instruction', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    ;(adapter as any).systemPrompt = 'Fake prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.ok(result.effectiveMessage.includes('Begin verification'))
    assert.ok(result.effectiveMessage.includes('Check every plan item'))
  })

  // ── buildPrompts guard ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // ── buildMcpConfig (inherits read-only from MpaBaseAdapter) ──

  test('buildMcpConfig_inherits_readonly_allowed_tools', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
  })

  test('buildMcpConfig_disallows_write_edit_bash', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
  })

  // ── onSessionStop clears state ──

  test('onSessionStop_clears_goal_and_prompt', () => {
    const adapter = new MpaVerifierAdapter({
      workspaceId: 'ws-1',
      goal: 'Verify',
      plan: { phases: [], summary: 'plan', planId: 'p1', estimatedEffort: 'medium', riskAssessment: 'low' }
    })
    adapter.setGoalCondition('All tests pass')
    ;(adapter as any).systemPrompt = 'some prompt'
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
    assert.equal((adapter as any).systemPrompt, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
