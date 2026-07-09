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
    workspacePath: '/tmp/bp-test',
    workspaceId: 'ws-bp-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {} },
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

  test('buildPrompts_returns_ctx_message_when_non_empty', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    ;(adapter as any).systemPrompt = 'Test prompt'
    const result = adapter.buildPrompts(makePromptCtx())
    assert.equal(result.systemPrompt, 'Test prompt')
    // ctx.message is 'hello' (non-empty) — should pass through
    assert.equal(result.effectiveMessage, 'hello')
  })

  test('buildPrompts_falls_back_to_phaseMessage_when_ctx_message_empty', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    ;(adapter as any).systemPrompt = 'Test prompt'
    const ctx = makePromptCtx()
    ctx.message = ''
    const result = adapter.buildPrompts(ctx)
    assert.equal(result.effectiveMessage, 'Test blueprint phase message')
  })

  test('buildPrompts_falls_back_to_phaseMessage_when_ctx_message_whitespace', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    ;(adapter as any).systemPrompt = 'Test prompt'
    const ctx = makePromptCtx()
    ctx.message = '   '
    const result = adapter.buildPrompts(ctx)
    assert.equal(result.effectiveMessage, 'Test blueprint phase message')
  })

  // ── buildMcpConfig ──

  test('buildMcpConfig_allowedTools_includes_read_glob_grep_websearch_webfetch', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(allowedTools.includes('Read'))
    assert.ok(allowedTools.includes('Glob'))
    assert.ok(allowedTools.includes('Grep'))
    assert.ok(allowedTools.includes('WebSearch'))
    assert.ok(allowedTools.includes('WebFetch'))
  })

  test('buildMcpConfig_disallowedTools_includes_write_edit_bash_agent', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { disallowedTools } = result
    assert.ok(disallowedTools, 'disallowedTools should be defined')
    assert.ok(disallowedTools.includes('Write'))
    assert.ok(disallowedTools.includes('Edit'))
    assert.ok(disallowedTools.includes('Bash'))
    assert.ok(disallowedTools.includes('Agent'))
    assert.ok(disallowedTools.includes('ToolSearch'))
  })

  test('buildMcpConfig_includes_code_graph_when_repomapEnabled_and_workspaceId', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: 'ws-1' }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should include code-graph tools'
    )
  })

  test('buildMcpConfig_excludes_code_graph_without_workspaceId', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx({ workspaceId: null }))
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      !allowedTools.some((t) => t.startsWith('mcp__code-graph__')),
      'Should exclude code-graph tools when workspaceId null'
    )
  })

  test('buildMcpConfig_includes_git_context_tools', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const result = adapter.buildMcpConfig(makeMcpCtx())
    const { allowedTools } = result
    assert.ok(allowedTools, 'allowedTools should be defined')
    assert.ok(
      allowedTools.some((t) => t.startsWith('mcp__git-context__')),
      'Should include git context tools'
    )
  })

  test('buildMcpConfig_includes_code_analysis_tools', () => {
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
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
    const adapter = new TestBlueprintAdapter({ workspaceId: 'ws-1', blueprintId: 'bp-1' })
    const emitted: unknown[] = []
    adapter.emitDetectedIntents({
      accumulatedText: 'some text',
      controlToolState: { plan: false, askUser: false },
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
