/**
 * Unit tests for CouncilMemberRoleAdapter.
 *
 * Tests: role, agentId, timeout, MCP strategy dispatch (outsider vs. other roles),
 * buildPrompts guard, onSessionStop cleanup, getIncludeGitContext gating.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { CouncilMemberRoleAdapter } from '../role-adapters/council-member.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'
import type { CouncilAdvisorRole } from '../../../shared/types'

// ── Helpers ──

function createAdapter(
  advisorRole: CouncilAdvisorRole = 'contrarian',
  overrides: Partial<ConstructorParameters<typeof CouncilMemberRoleAdapter>[0]> = {}
) {
  return new CouncilMemberRoleAdapter({
    workspaceId: 'ws-1',
    advisorRole,
    framedInput: {
      inputType: 'plan',
      originalUserRequest: 'Add a caching layer',
      planContent: '# Plan\nAdd Redis caching.',
      filesInScope: ['src/cache.ts'],
      structuredPlan: null,
      workspaceContext: ''
    },
    ...overrides
  })
}

function makePromptCtx(): AdapterPromptContext {
  return {
    message: 'hello',
    conversationId: 'c1',
    hasImages: false,
    turnCount: 1,
    sessionId: undefined,
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    costPreference: 'balanced'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/council-test',
    workspaceId: 'ws-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
    ...overrides
  }
}

describe('CouncilMemberRoleAdapter', () => {
  // ── Identity ──

  test('role_is_council-member', () => {
    const a = createAdapter('contrarian')
    assert.equal(a.role, 'council-member')
  })

  test('agentId_for_contrarian', () => {
    const a = createAdapter('contrarian', { workspaceId: 'ws-42' })
    assert.equal(a.agentId, 'council-contrarian-ws-42')
  })

  test('agentId_for_outsider', () => {
    const a = createAdapter('outsider', { workspaceId: 'ws-7' })
    assert.equal(a.agentId, 'council-outsider-ws-7')
  })

  test('agentId_for_executor', () => {
    const a = createAdapter('executor', { workspaceId: 'ws-9' })
    assert.equal(a.agentId, 'council-executor-ws-9')
  })

  test('agentId_for_first-principles', () => {
    const a = createAdapter('first-principles', { workspaceId: 'ws-3' })
    assert.equal(a.agentId, 'council-first-principles-ws-3')
  })

  test('agentId_for_expansionist', () => {
    const a = createAdapter('expansionist', { workspaceId: 'ws-5' })
    assert.equal(a.agentId, 'council-expansionist-ws-5')
  })

  // ── Timeout ──

  test('interactionTimeoutMs_is_5_minutes', () => {
    const a = createAdapter()
    assert.equal(a.interactionTimeoutMs, 5 * 60_000)
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = createAdapter()
    assert.throws(
      () => a.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  test('buildPrompts_returns_systemPrompt_and_effectiveMessage_after_setup', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'Test council prompt'
    const result = a.buildPrompts(makePromptCtx())
    assert.equal(result.systemPrompt, 'Test council prompt')
    assert.equal(result.effectiveMessage, 'Begin your review.')
  })

  // ── MCP Strategy ──

  test('outsider_getMcpStrategy_returns_none', () => {
    const a = createAdapter('outsider')
    assert.equal((a as any).getMcpStrategy(makeMcpCtx()), 'none')
  })

  test('contrarian_getMcpStrategy_returns_readonly', () => {
    const a = createAdapter('contrarian')
    assert.equal((a as any).getMcpStrategy(makeMcpCtx()), 'readonly')
  })

  test('executor_getMcpStrategy_returns_readonly', () => {
    const a = createAdapter('executor')
    assert.equal((a as any).getMcpStrategy(makeMcpCtx()), 'readonly')
  })

  test('outsider_buildMcpConfig_returns_no_tools', () => {
    const a = createAdapter('outsider')
    const result = a.buildMcpConfig(makeMcpCtx())
    assert.deepEqual(result.allowedTools, [])
    assert.ok(result.disallowedTools!.includes('Read'))
    assert.ok(result.disallowedTools!.includes('Write'))
  })

  test('contrarian_buildMcpConfig_returns_readonly_tools', () => {
    const a = createAdapter('contrarian')
    const result = a.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools!.includes('Read'))
    assert.ok(result.disallowedTools!.includes('Write'))
    assert.ok(result.disallowedTools!.includes('Edit'))
    assert.ok(result.disallowedTools!.includes('Bash'))
  })

  // ── getIncludeGitContext ──

  test('getIncludeGitContext_true_for_claude_provider', () => {
    const a = createAdapter('contrarian')
    assert.equal((a as any).getIncludeGitContext(), true)
  })

  test('getIncludeGitContext_false_for_local_llm_provider', () => {
    const a = createAdapter('contrarian', { llmProvider: 'local-llm' })
    assert.equal((a as any).getIncludeGitContext(), false)
  })

  // ── onSessionStop ──

  test('onSessionStop_clears_state', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'something'
    ;(a as any).resolvedModel = 'claude-sonnet-4-6'
    a.onSessionStop()
    assert.equal((a as any).systemPrompt, null)
    assert.equal((a as any).resolvedModel, undefined)
  })

  test('onSessionStop_resets_feature_flags', () => {
    const a = createAdapter()
    ;(a as any).repomapEnabled = false
    ;(a as any).semanticSearchEnabled = false
    a.onSessionStop()
    assert.equal((a as any).repomapEnabled, true)
    assert.equal((a as any).semanticSearchEnabled, true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
