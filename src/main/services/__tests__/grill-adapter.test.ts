/**
 * Unit tests for GrillRoleAdapter — drives grill evaluations for existing codebases.
 *
 * Tests pure accessors, MCP strategy, git-context gating, buildPrompts shape,
 * and lifecycle methods (onSessionStop, persistMemory no-op).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { GrillRoleAdapter } from '../role-adapters/grill.adapter'
import type { AdapterMcpContext } from '../agent-session.types'

// ── Helpers ──

function createAdapter(overrides: Partial<ConstructorParameters<typeof GrillRoleAdapter>[0]> = {}) {
  return new GrillRoleAdapter({
    workspaceId: 'ws-1',
    trackId: 'architecture',
    ideaTitle: 'Test Idea',
    ideaDescription: 'Test description for the idea.',
    ...overrides
  })
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/grill-test',
    workspaceId: 'ws-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('GrillRoleAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_grill', () => {
    const adapter = createAdapter()
    assert.equal(adapter.role, 'grill')
  })

  test('agentId_includes_trackId_and_workspaceId', () => {
    const adapter = createAdapter({ workspaceId: 'ws-42', trackId: 'security' })
    assert.equal(adapter.agentId, 'grill-security-ws-42')
  })

  test('interactionTimeoutMs_defaults_to_10_minutes', () => {
    const adapter = createAdapter()
    assert.equal(adapter.interactionTimeoutMs, 10 * 60_000)
  })

  test('default_llmProvider_is_claude', () => {
    const adapter = createAdapter()
    // Verified through getIncludeGitContext — claude → true
    const mcpConfig = adapter.buildMcpConfig(makeMcpCtx())
    // For claude provider, git context should be included in readonly MCP
    assert.ok(
      mcpConfig.allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Claude provider should include git context tools'
    )
  })

  // ── getMcpStrategy → 'readonly' ──

  test('buildMcpConfig_uses_readonly_strategy', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    // Readonly: Read allowed, Write disallowed
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
  })

  // ── getIncludeGitContext ──

  test('claude_provider_includes_git_context', () => {
    const adapter = createAdapter({ llmProvider: 'claude' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__git-context__')))
  })

  test('local_llm_provider_excludes_git_context', () => {
    const adapter = createAdapter({ llmProvider: 'local-llm' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__git-context__')))
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = createAdapter()
    assert.throws(
      () =>
        adapter.buildPrompts({
          message: 'test',
          conversationId: 'c1',
          hasImages: false,
          turnCount: 1,
          mode: 'plan',
          workspacePath: '/tmp',
          workspaceId: 'ws-1',
          costPreference: 'balanced'
        }),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // ── onSessionStop ──

  test('onSessionStop_completes_without_error', () => {
    const adapter = createAdapter()
    adapter.onSessionStop()
    // Should reset feature flags
    const result = adapter.buildMcpConfig(makeMcpCtx())
    // After stop, repomapEnabled and semanticSearchEnabled are reset to true
    assert.ok(result.allowedTools.includes('Read'))
  })

  test('onSessionStop_is_safe_to_call_twice', () => {
    const adapter = createAdapter()
    adapter.onSessionStop()
    adapter.onSessionStop()
    // No crash
    assert.ok(true)
  })

  // ── persistMemory (no-op) ──

  test('persistMemory_is_no_op', () => {
    // Access via (adapter as any) — persistMemory is protected
    const adapter = createAdapter() as unknown as {
      persistMemory: (
        m: { type: string; title: string; content: string },
        cid: string | null
      ) => void
    }
    // Should not throw or attempt DB access
    adapter.persistMemory(
      { type: 'project', title: 'test', content: 'content' },
      'conv-1'
    )
    assert.ok(true, 'persistMemory completed without error')
  })

  // ── Different tracks ──

  test('agentId_uses_requirements_track', () => {
    const adapter = createAdapter({ trackId: 'requirements' })
    assert.equal(adapter.agentId, 'grill-requirements-ws-1')
  })

  test('agentId_uses_testing_track', () => {
    const adapter = createAdapter({ trackId: 'testing' })
    assert.equal(adapter.agentId, 'grill-testing-ws-1')
  })

  // ── MCP config with different workspaceId presence ──

  test('buildMcpConfig_includes_code_graph_with_workspace', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    assert.ok(result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_excludes_code_graph_without_workspace', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    assert.ok(!result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
