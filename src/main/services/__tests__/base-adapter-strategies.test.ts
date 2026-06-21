/**
 * Unit tests for BaseRoleAdapter — strategy pattern coverage.
 *
 * Uses a concrete TestAdapter subclass to test the strategy dispatch in
 * buildMcpConfig, appendToolGuidance, buildControlCallbacks, and helper methods.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BaseRoleAdapter, type McpStrategy } from '../role-adapters/base.adapter'
import type {
  AdapterMcpContext,
  AdapterPromptContext,
  AdapterPromptResult
} from '../agent-session.types'
import type { AgentRole } from '../../../shared/types'

// ── Concrete subclass for testing ───────────────────────────────────────

class TestAdapter extends BaseRoleAdapter {
  readonly role = 'da-vinci' as AgentRole
  readonly agentId = 'test-adapter-1'
  private strategy: McpStrategy = 'full'

  setStrategy(s: McpStrategy): void {
    this.strategy = s
  }

  protected override getMcpStrategy(): McpStrategy {
    return this.strategy
  }

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    return { systemPrompt: 'test prompt', effectiveMessage: 'hello' }
  }
}

function makeMcpCtx(overrides: Partial<AdapterMcpContext> = {}): AdapterMcpContext {
  return {
    mode: 'plan',
    workspacePath: '/tmp/test',
    workspaceId: 'ws-1',
    conversationId: null,
    controlCallbacks: { onPlan: () => {}, onAskUser: () => {}, onMemory: () => {} },
    ...overrides
  }
}

describe('BaseRoleAdapter — strategy dispatch', () => {
  // ── getMcpStrategy dispatch ──

  test('strategy_none_returns_no_tools_config', () => {
    const a = new TestAdapter()
    a.setStrategy('none')
    const result = a.buildMcpConfig(makeMcpCtx())
    assert.deepEqual(result.allowedTools, [])
    assert.ok(result.disallowedTools.length > 0)
  })

  test('strategy_readonly_returns_readonly_config', () => {
    const a = new TestAdapter()
    a.setStrategy('readonly')
    const result = a.buildMcpConfig(makeMcpCtx())
    assert.ok(result.allowedTools.includes('Read'))
    assert.ok(result.disallowedTools.includes('Write'))
    assert.ok(result.disallowedTools.includes('Edit'))
  })

  test('strategy_custom_returns_default_no_tools', () => {
    const a = new TestAdapter()
    a.setStrategy('custom')
    const result = a.buildMcpConfig(makeMcpCtx())
    // Base class buildCustomMcpConfig defaults to buildNoToolsConfig
    assert.deepEqual(result.allowedTools, [])
  })

  // ── buildControlCallbacks ──

  test('buildControlCallbacks_returns_onPlan_onAskUser_onMemory', () => {
    const a = new TestAdapter()
    const cbs = a.buildControlCallbacks({
      conversationId: 'conv-1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    assert.equal(typeof cbs.onPlan, 'function')
    assert.equal(typeof cbs.onAskUser, 'function')
    assert.equal(typeof cbs.onMemory, 'function')
  })

  test('buildControlCallbacks_onPlan_callable', () => {
    const a = new TestAdapter()
    const cbs = a.buildControlCallbacks({
      conversationId: null,
      emit: () => {},
      getAccumulatedText: () => ''
    })
    // Should not throw
    cbs.onPlan()
  })

  // ── resolveWorkspaceId ──

  test('resolveWorkspaceId_defaults_to_null', () => {
    const a = new TestAdapter()
    assert.equal((a as any).resolveWorkspaceId(), null)
  })

  // ── appendToolGuidance ──

  test('appendToolGuidance_adds_tool_priority_section', () => {
    const a = new TestAdapter()
    a.setStrategy('full')
    const result = (a as any).appendToolGuidance('Base prompt text', 1)
    assert.ok(result.includes('Base prompt text'))
    // Should have added Tool Priority directive
    assert.ok(result.length > 'Base prompt text'.length)
  })

  test('appendToolGuidance_skips_when_already_present', () => {
    const a = new TestAdapter()
    const base = 'Base prompt\n## Tool Priority\nExisting guidance'
    const result = (a as any).appendToolGuidance(base, 1)
    // Should not duplicate Tool Priority
    const matches = result.match(/## Tool Priority/g)
    assert.equal(matches?.length, 1, 'Should not duplicate Tool Priority section')
  })

  test('appendToolGuidance_with_none_strategy_skips_tool_priority', () => {
    const a = new TestAdapter()
    a.setStrategy('none')
    const result = (a as any).appendToolGuidance('Base prompt', 1)
    // None strategy should not add Tool Priority
    assert.ok(!result.includes('## Tool Priority'))
  })

  // ── getIncludeGitContext ──

  test('getIncludeGitContext_defaults_to_true', () => {
    const a = new TestAdapter()
    assert.equal((a as any).getIncludeGitContext(), true)
  })

  // ── applyLocalLlmTimeout ──

  test('applyLocalLlmTimeout_extends_for_local_llm', () => {
    const a = new TestAdapter()
    ;(a as any).applyLocalLlmTimeout('local-llm')
    assert.equal(a.interactionTimeoutMs, 45 * 60_000)
  })

  test('applyLocalLlmTimeout_no_op_for_claude', () => {
    const a = new TestAdapter()
    const original = a.interactionTimeoutMs
    ;(a as any).applyLocalLlmTimeout('claude')
    assert.equal(a.interactionTimeoutMs, original)
  })

  test('applyLocalLlmTimeout_custom_minutes', () => {
    const a = new TestAdapter()
    ;(a as any).applyLocalLlmTimeout('local-llm', 20)
    assert.equal(a.interactionTimeoutMs, 20 * 60_000)
  })

  // ── lockMcpFlags / unlockMcpFlags ──

  test('lockMcpFlags_snapshots_current_flags', () => {
    const a = new TestAdapter()
    ;(a as any).repomapEnabled = false
    ;(a as any).lockMcpFlags()
    const locked = (a as any).getLockedMcpFlags()
    assert.equal(locked.repomapEnabled, false)
  })

  test('unlockMcpFlags_clears_snapshot', () => {
    const a = new TestAdapter()
    ;(a as any).lockMcpFlags()
    ;(a as any).unlockMcpFlags()
    // After unlock, getLockedMcpFlags falls back to live flags
    ;(a as any).repomapEnabled = true
    const flags = (a as any).getLockedMcpFlags()
    assert.equal(flags.repomapEnabled, true)
  })

  // ── invalidateToneCache ──

  test('invalidateToneCache_clears_cache', () => {
    const a = new TestAdapter()
    ;(a as any).cachedTone = 'concise'
    ;(a as any).cachedToneConversationId = 'conv-1'
    ;(a as any).invalidateToneCache()
    assert.equal((a as any).cachedTone, null)
    assert.equal((a as any).cachedToneConversationId, null)
  })

  // ── Lifecycle ──

  test('onSessionStart_is_no_op_by_default', async () => {
    const a = new TestAdapter()
    await a.onSessionStart({ workspacePath: '/tmp', presetId: null })
  })

  test('onSessionStop_is_no_op_by_default', () => {
    const a = new TestAdapter()
    a.onSessionStop()
  })

  test('onConversationSwitch_is_no_op_by_default', () => {
    const a = new TestAdapter()
    a.onConversationSwitch('conv-new')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
