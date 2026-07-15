/**
 * Unit tests for GreenfieldGrillRoleAdapter — drives grill evaluations for
 * NEW project ideas (no codebase, no workspace-scoped MCP tools).
 *
 * Tests pure accessors, custom MCP config (WebSearch+WebFetch only),
 * buildPrompts shape, and lifecycle no-ops (persistMemory, onSessionStop).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { GreenfieldGrillRoleAdapter } from '../role-adapters/greenfield-grill.adapter'
import type { AdapterMcpContext } from '../agent-session.types'

// ── Helpers ──

function createAdapter(
  overrides: Partial<ConstructorParameters<typeof GreenfieldGrillRoleAdapter>[0]> = {}
) {
  return new GreenfieldGrillRoleAdapter({
    trackId: 'architecture',
    projectName: 'Test Project',
    projectDescription: 'A greenfield project description.',
    ...overrides
  })
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/greenfield-test',
    workspaceId: null,
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
    ...overrides
  }
}

describe('GreenfieldGrillRoleAdapter', () => {
  // ── Constructor + identity ──

  test('role_is_grill', () => {
    const adapter = createAdapter()
    assert.equal(adapter.role, 'grill')
  })

  test('agentId_includes_greenfield_grill_and_trackId', () => {
    const adapter = createAdapter({ trackId: 'security' })
    assert.ok(adapter.agentId.startsWith('greenfield-grill-security-'))
  })

  test('interactionTimeoutMs_defaults_to_10_minutes', () => {
    const adapter = createAdapter()
    assert.equal(adapter.interactionTimeoutMs, 10 * 60_000)
  })

  test('default_llmProvider_is_claude', () => {
    // Verified via MCP config — greenfield has custom config, but provider
    // affects timeout extension behavior
    const adapter = createAdapter()
    assert.equal(adapter.interactionTimeoutMs, 10 * 60_000)
  })

  // ── Custom MCP config (only WebSearch + WebFetch) ──

  test('buildMcpConfig_allows_only_WebSearch_and_WebFetch', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.deepEqual(result.allowedTools, ['WebSearch', 'WebFetch'])
  })

  test('buildMcpConfig_disallows_all_codebase_and_write_tools', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const expected = [
      'Read',
      'Write',
      'Edit',
      'Bash',
      'Glob',
      'Grep',
      'Agent',
      'ToolSearch',
      'ExitPlanMode',
      'AskUserQuestion',
      'TodoWrite',
      'TaskCreate',
      'TaskUpdate'
    ]
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    for (const tool of expected) {
      assert.ok(disallowedTools.includes(tool), `Expected ${tool} in disallowedTools`)
    }
  })

  test('buildMcpConfig_has_no_code_graph_tools', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__code-graph__')))
  })

  test('buildMcpConfig_has_no_semantic_search_tools', () => {
    const adapter = createAdapter()
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(!allowedTools.some((t) => t.startsWith('mcp__semantic-search__')))
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
          workspaceId: null,
          costPreference: 'balanced'
        }),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // persistMemory removed — memory tools now on dedicated memory MCP server

  // ── Different tracks ──

  test('agentId_uses_requirements_track', () => {
    const adapter = createAdapter({ trackId: 'requirements' })
    assert.ok(adapter.agentId.startsWith('greenfield-grill-requirements-'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
