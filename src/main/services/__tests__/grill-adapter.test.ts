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
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
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
    const { allowedTools } = mcpConfig
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Claude provider should include git context tools'
    )
  })

  // ── getMcpStrategy → 'readonly' ──

  test('buildMcpConfig_uses_readonly_strategy', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    // Readonly: Read allowed, Write disallowed
    const { allowedTools, disallowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
    assert.ok(disallowedTools.includes('Write'))
    assert.ok(disallowedTools.includes('Edit'))
    assert.ok(disallowedTools.includes('Bash'))
  })

  // ── getIncludeGitContext ──

  test('claude_provider_includes_git_context', () => {
    const adapter = createAdapter({ llmProvider: 'claude' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.some((t) => t.startsWith('mcp__git-context__')))
  })

  test('local_llm_provider_excludes_git_context', () => {
    const adapter = createAdapter({ llmProvider: 'local-llm' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__git-context__')))
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
          sessionId: undefined,
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
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
  })

  // persistMemory removed — memory tools now on dedicated memory MCP server

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
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_excludes_code_graph_without_workspace', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
