/**
 * Unit tests for BlueprintBaseAdapter — abstract base for Blueprint pipeline adapters.
 *
 * Uses a concrete TestBlueprintAdapter subclass (same pattern as MPA base adapter tests).
 * Tests: goal conditions, timeout, MCP config, buildPrompts guard, emitDetectedIntents,
 * onSessionStop cleanup, code-graph/semantic-search conditional inclusion.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintBaseAdapter } from '../role-adapters/blueprint/blueprint-base.adapter'
import type { AdapterMcpContext, AdapterPromptContext } from '../agent-session.types'
import type { AgentRole, ModelAction } from '../../../shared/types'

// ── Concrete subclass for testing ───────────────────────────────────────

class TestBlueprintAdapter extends BlueprintBaseAdapter {
  readonly role = 'blueprint-specify' as AgentRole
  readonly agentId = 'test-blueprint'

  protected getModelAction(): ModelAction {
    return 'blueprint:specify'
  }

  protected buildPhaseSystemPrompt(): string {
    return 'Test blueprint system prompt'
  }

  getPhaseMessage(): string {
    return 'Test blueprint phase message'
  }
}

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

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/bp-test',
    workspaceId: 'ws-bp-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('BlueprintBaseAdapter', () => {
  // ── Constructor ──

  test('stores_workspaceId_and_blueprintId', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-42' })
    assert.equal((adapter as any).workspaceId, 'ws-1')
    assert.equal((adapter as any).blueprintId, 'bp-42')
  })

  test('role_matches_concrete_subclass', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    assert.equal(adapter.role, 'blueprint-specify')
  })

  test('agentId_matches_concrete_subclass', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    assert.equal(adapter.agentId, 'test-blueprint')
  })

  // ── Timeout ──

  test('interactionTimeoutMs_defaults_to_30_minutes', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    assert.equal(adapter.interactionTimeoutMs, 30 * 60_000)
  })

  // ── Goal conditions ──

  test('getGoalCondition_defaults_to_null', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    assert.equal(adapter.getGoalCondition(), null)
  })

  test('setGoalCondition_then_getGoalCondition_roundtrip', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    adapter.setGoalCondition('All tests pass')
    assert.equal(adapter.getGoalCondition(), 'All tests pass')
  })

  test('setGoalCondition_overwrites_previous_value', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    adapter.setGoalCondition('first')
    adapter.setGoalCondition('second')
    assert.equal(adapter.getGoalCondition(), 'second')
  })

  // ── buildPrompts ──

  test('buildPrompts_throws_before_onSessionStart', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    assert.throws(
      () => adapter.buildPrompts(makePromptCtx()),
      /buildPrompts\(\) called before onSessionStart\(\)/
    )
  })

  test('buildPrompts_returns_systemPrompt_and_effectiveMessage_after_setup', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    ;(adapter as any).systemPrompt = 'Test prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(result.systemPrompt, 'Test prompt')
    assert.equal(result.effectiveMessage, 'Test blueprint phase message')
  })

  // ── buildMcpConfig ──

  test('buildMcpConfig_allowedTools_includes_read_glob_grep_websearch_webfetch', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.allowedTools.includes('Glob'))
    assert.ok(result.allowedTools.includes('Grep'))
    assert.ok(result.allowedTools.includes('WebSearch'))
    assert.ok(result.allowedTools.includes('WebFetch'))
  })

  test('buildMcpConfig_disallowedTools_includes_write_edit_bash_agent', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
    assert.ok(result.disallowedTools.includes('Bash'))
    assert.ok(result.disallowedTools.includes('Agent'))
    assert.ok(result.disallowedTools.includes('ToolSearch'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should include code-graph tools'
    )
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    assert.ok(
      !result.allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should exclude code-graph tools when workspaceId null'
    )
  })

  test('buildMcpConfig_includes_git_context_tools', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Should include git context tools'
    )
  })

  test('buildMcpConfig_includes_code_analysis_tools', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    assert.ok(
      result.allowedTools.some((t) => t.startsWith('mcp__code-analysis__')),
      'Should include code analysis tools'
    )
  })

  // ── emitDetectedIntents (no-op) ──

  test('emitDetectedIntents_is_no_op', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const emitted: unknown[] = []
    adapter.emitDetectedIntents({
      accumulatedText: 'some text',
      controlToolState: { plan: false, askUser: false, memory: false },
      mode: 'plan',
      conversationId: 'c1',
      emit: (_evt, payload) => emitted.push(payload)
    })
    assert.equal(emitted.length, 0, 'Blueprint adapters should not emit intents')
  })

  // ── onSessionStop ──

  test('onSessionStop_clears_goal_condition_and_systemPrompt', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    adapter.setGoalCondition('some condition')
    ;(adapter as any).systemPrompt = 'some prompt'
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
    assert.equal((adapter as any).systemPrompt, null)
  })

  test('onSessionStop_is_safe_to_call_twice', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    adapter.onSessionStop()
    adapter.onSessionStop()
    assert.equal(adapter.getGoalCondition(), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
