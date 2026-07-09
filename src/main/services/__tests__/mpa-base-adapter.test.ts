/**
 * Unit tests for MpaBaseAdapter — abstract base for MPA pipeline phase adapters.
 *
 * Uses a concrete TestMpaAdapter subclass to test the base class methods:
 * goal conditions, timeout, MCP config, no-op overrides, resolveWorkspaceId.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { MpaBaseAdapter } from '../role-adapters/mpa/mpa-base.adapter'
import type { AdapterMcpContext } from '../agent-session.types'
import type { AgentRole } from '../../../shared/types'

// ── Concrete subclass for testing ───────────────────────────────────────

class TestMpaAdapter extends MpaBaseAdapter {
  readonly role = 'mpa-planner' as AgentRole
  readonly agentId = 'test-mpa-adapter'

  protected buildPhaseSystemPrompt(): string {
    return 'Test MPA system prompt'
  }

  protected getPhaseMessage(): string {
    return 'Test MPA phase message'
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/mpa-test',
    workspaceId: 'ws-mpa-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
    ...overrides
  }
}

describe('MpaBaseAdapter', () => {
  // ── Constructor + identity ──

  test('role_matches_concrete_subclass', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.role, 'mpa-planner')
  })

  test('agentId_matches_concrete_subclass', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.agentId, 'test-mpa-adapter')
  })

  // ── Timeout ──

  test('interactionTimeoutMs_defaults_to_30_minutes', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.interactionTimeoutMs, 30 * 60_000)
  })

  // ── Goal conditions ──

  test('getGoalCondition_defaults_to_null', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    assert.equal(adapter.getGoalCondition(), null)
  })

  test('setGoalCondition_then_getGoalCondition_roundtrip', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    adapter.setGoalCondition('All tests pass with >80% coverage')
    assert.equal(adapter.getGoalCondition(), 'All tests pass with >80% coverage')
  })

  test('setGoalCondition_overwrites_previous_value', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    adapter.setGoalCondition('first condition')
    adapter.setGoalCondition('second condition')
    assert.equal(adapter.getGoalCondition(), 'second condition')
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    assert.throws(
      () =>
        adapter.buildPrompts({
          message: 'hello',
          conversationId: 'c1',
          hasImages: false,
          turnCount: 1,
          sessionId: undefined,
          mode: 'plan',
          workspacePath: '/tmp/test',
          workspaceId: 'ws-1',
          costPreference: 'balanced'
        }),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  // ── buildMcpConfig ──

  test('buildMcpConfig_allowedTools_includes_read_glob_grep', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
    assert.ok(allowedTools.includes('Glob'))
    assert.ok(allowedTools.includes('Grep'))
    assert.ok(allowedTools.includes('WebSearch'))
    assert.ok(allowedTools.includes('WebFetch'))
  })

  test('buildMcpConfig_disallowedTools_includes_write_edit_bash', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(disallowedTools.includes('Write'))
    assert.ok(disallowedTools.includes('Edit'))
    assert.ok(disallowedTools.includes('Bash'))
    assert.ok(disallowedTools.includes('Agent'))
    assert.ok(disallowedTools.includes('ToolSearch'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomap_enabled_and_workspaceId', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    // repomapEnabled defaults to true — should include code-graph tools
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should include code-graph tools when repomapEnabled and workspaceId set'
    )
  })

  test('buildMcpConfig_excludes_code_graph_when_no_workspaceId', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      !allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should exclude code-graph tools when workspaceId is null'
    )
  })

  test('buildMcpConfig_includes_git_context_tools', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Should include git context tools'
    )
  })

  test('buildMcpConfig_includes_code_analysis_tools', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__code-analysis__')),
      'Should include code analysis tools'
    )
  })

  // ── emitDetectedIntents (no-op) ──

  test('emitDetectedIntents_is_no_op', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    const emitted: unknown[] = []
    adapter.emitDetectedIntents({
      accumulatedText: 'some text',
      controlToolState: { plan: false, askUser: false },
      mode: 'plan',
      conversationId: 'c1',
      emit: (_evt, payload) => emitted.push(payload)
    })
    assert.equal(emitted.length, 0, 'MPA adapters should not emit intents')
  })

  // ── onSessionStop ──

  test('onSessionStop_clears_goal_condition', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    adapter.setGoalCondition('some condition')
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
  })

  test('onSessionStop_is_safe_to_call_twice', () => {
    const adapter = new TestMpaAdapter({ workspaceId: 'ws-1' })
    adapter.onSessionStop()
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
