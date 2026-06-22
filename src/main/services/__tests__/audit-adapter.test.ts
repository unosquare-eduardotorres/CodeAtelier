/**
 * Unit tests for AuditRoleAdapter — single-shot read-only workspace auditor.
 *
 * Tests: role, agentId, timeout, MCP strategy (readonly), buildPrompts guard,
 * emitDetectedIntents no-op, onSessionStop cleanup, getIncludeGitContext.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AuditRoleAdapter } from '../role-adapters/audit.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'

// ── Helpers ──

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof AuditRoleAdapter>[0]> = {}
) {
  return new AuditRoleAdapter({
    workspaceId: 'ws-1',
    trackId: 'code',
    mode: 'deep',
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
    workspacePath: '/tmp/audit-test',
    workspaceId: 'ws-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('AuditRoleAdapter', () => {
  // ── Identity ──

  test('role_is_audit', () => {
    const a = createAdapter()
    assert.equal(a.role, 'audit')
  })

  test('agentId_includes_trackId_and_workspaceId', () => {
    const a = createAdapter({ workspaceId: 'ws-42', trackId: 'testing' })
    assert.equal(a.agentId, 'audit-testing-ws-42')
  })

  test('agentId_for_database_track', () => {
    const a = createAdapter({ trackId: 'database', workspaceId: 'ws-7' })
    assert.equal(a.agentId, 'audit-database-ws-7')
  })

  // ── Timeout ──

  test('interactionTimeoutMs_is_5_minutes', () => {
    const a = createAdapter()
    assert.equal(a.interactionTimeoutMs, 5 * 60_000)
  })

  // ── MCP Strategy ──

  test('getMcpStrategy_returns_readonly', () => {
    const a = createAdapter()
    assert.equal((a as any).getMcpStrategy(), 'readonly')
  })

  test('buildMcpConfig_readonly_includes_read_excludes_write', () => {
    const a = createAdapter()
    const result = a.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools!.includes('Read'))
    assert.ok(result.disallowedTools!.includes('Write'))
    assert.ok(result.disallowedTools!.includes('Edit'))
    assert.ok(result.disallowedTools!.includes('Bash'))
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const a = createAdapter()
    assert.throws(
      () => a.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  test('buildPrompts_returns_effectiveMessage_after_setup', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'Audit prompt'
    const result = a.buildPrompts(makePromptCtx())
    assert.equal(result.systemPrompt, 'Audit prompt')
    assert.equal(result.effectiveMessage, 'Begin your audit.')
  })

  // ── emitDetectedIntents (no-op) ──

  test('emitDetectedIntents_is_no_op', () => {
    const a = createAdapter()
    const emitted: unknown[] = []
    a.emitDetectedIntents({
      accumulatedText: 'audit findings here',
      controlToolState: { plan: false, askUser: false, memory: false },
      mode: 'plan',
      conversationId: 'c1',
      emit: (_evt, payload) => emitted.push(payload)
    })
    assert.equal(emitted.length, 0, 'Audit adapter should not emit intents')
  })

  // ── getIncludeGitContext ──

  test('getIncludeGitContext_true_for_claude_provider', () => {
    const a = createAdapter()
    assert.equal((a as any).getIncludeGitContext(), true)
  })

  test('getIncludeGitContext_false_for_local_llm', () => {
    const a = createAdapter({ llmProvider: 'local-llm' })
    assert.equal((a as any).getIncludeGitContext(), false)
  })

  // ── persistMemory (no-op) ──

  test('persistMemory_is_no_op', () => {
    const a = createAdapter()
    ;(a as any).persistMemory({ type: 'project', title: 'test', content: 'test' }, null)
    // Should not throw
  })

  // ── onSessionStop ──

  test('onSessionStop_clears_systemPrompt', () => {
    const a = createAdapter()
    ;(a as any).systemPrompt = 'something'
    a.onSessionStop()
    assert.equal((a as any).systemPrompt, null)
  })

  test('onSessionStop_resets_feature_flags', () => {
    const a = createAdapter()
    ;(a as any).repomapEnabled = false
    ;(a as any).semanticSearchEnabled = false
    a.onSessionStop()
    assert.equal((a as any).repomapEnabled, true)
    assert.equal((a as any).semanticSearchEnabled, true)
  })

  test('onSessionStop_is_safe_to_call_twice', () => {
    const a = createAdapter()
    a.onSessionStop()
    a.onSessionStop()
    assert.equal((a as any).systemPrompt, null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
