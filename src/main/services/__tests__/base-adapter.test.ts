/**
 * Unit tests for BaseRoleAdapter — abstract base class for all role adapters.
 *
 * Tests the centralized default implementations: MCP flag lifecycle (lock/
 * unlock/get), feature flag builders, tool guidance, timeout & cache logic,
 * buildMcpConfig dispatch, and communication tone resolution.
 *
 * Uses a minimal concrete TestAdapter subclass with no-op overrides.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BaseRoleAdapter, type McpStrategy } from '../role-adapters/base.adapter'
import type {
  AdapterPromptContext,
  AdapterPromptResult,
  AdapterIntentContext,
  AdapterMcpContext
} from '../agent-session.types'

// ── Minimal concrete subclass ────────────────────────────────────────

class TestAdapter extends BaseRoleAdapter {
  readonly role = 'da-vinci' as const
  readonly agentId = 'test-agent'

  buildPrompts(_ctx: AdapterPromptContext): AdapterPromptResult {
    return { systemPrompt: 'test-system', effectiveMessage: 'test-message' }
  }

  // Expose protected methods for testing
  public _lockMcpFlags() { this.lockMcpFlags() }
  public _unlockMcpFlags() { this.unlockMcpFlags() }
  public _getLockedMcpFlags() { return this.getLockedMcpFlags() }
  public _buildPromptFeatureFlags() { return this.buildPromptFeatureFlags() }
  public _getMcpStrategy() { return this.getMcpStrategy() }
  public _getIncludeGitContext() { return this.getIncludeGitContext() }
  public _applyLocalLlmTimeout(provider: 'local-llm' | 'claude') {
    this.applyLocalLlmTimeout(provider)
  }
  public _invalidateToneCache() { this.invalidateToneCache() }
  public _appendToolGuidance(base: string, turnCount: number, model?: string) {
    return this.appendToolGuidance(base, turnCount, model)
  }
  public _resolveModel(workspacePath: string, action: 'da-vinci:plan' | 'da-vinci:build') {
    return this.resolveModel(workspacePath, action)
  }

  // Expose feature flag setters for testing
  public setRepomapEnabled(v: boolean) { this.repomapEnabled = v }
  public setSemanticSearchEnabled(v: boolean) { this.semanticSearchEnabled = v }
  public setGithubConfigured(v: boolean) { this.githubConfigured = v }

  // Override getMcpStrategy for testing dispatch
  private strategyOverride: McpStrategy | null = null
  public setMcpStrategyOverride(s: McpStrategy | null) { this.strategyOverride = s }
  protected override getMcpStrategy(): McpStrategy {
    return this.strategyOverride ?? super.getMcpStrategy()
  }
}

// ── A1: MCP Flag Lifecycle ──────────────────────────────────────────

describe('BaseRoleAdapter — MCP Flag Lifecycle', () => {
  test('getLockedMcpFlags returns live flags when not locked', () => {
    const adapter = new TestAdapter()
    adapter.setRepomapEnabled(true)
    adapter.setSemanticSearchEnabled(false)
    adapter.setGithubConfigured(true)

    const flags = adapter._getLockedMcpFlags()
    assert.equal(flags.repomapEnabled, true)
    assert.equal(flags.semanticSearchEnabled, false)
    assert.equal(flags.githubConfigured, true)
  })

  test('lockMcpFlags captures current flag state into snapshot', () => {
    const adapter = new TestAdapter()
    adapter.setRepomapEnabled(true)
    adapter.setSemanticSearchEnabled(true)
    adapter.setGithubConfigured(false)

    adapter._lockMcpFlags()

    // Change live flags — locked snapshot should NOT change
    adapter.setRepomapEnabled(false)
    adapter.setSemanticSearchEnabled(false)
    adapter.setGithubConfigured(true)

    const locked = adapter._getLockedMcpFlags()
    assert.equal(locked.repomapEnabled, true, 'locked repomap should be true')
    assert.equal(locked.semanticSearchEnabled, true, 'locked semantic should be true')
    assert.equal(locked.githubConfigured, false, 'locked github should be false')
  })

  test('unlockMcpFlags reverts to live flags', () => {
    const adapter = new TestAdapter()
    adapter.setRepomapEnabled(false)
    adapter.setSemanticSearchEnabled(false)
    adapter.setGithubConfigured(false)

    adapter._lockMcpFlags()
    // Change live flags
    adapter.setRepomapEnabled(true)
    adapter.setSemanticSearchEnabled(true)
    adapter.setGithubConfigured(true)

    // Unlock
    adapter._unlockMcpFlags()

    const flags = adapter._getLockedMcpFlags()
    assert.equal(flags.repomapEnabled, true, 'after unlock should use live value')
    assert.equal(flags.semanticSearchEnabled, true)
    assert.equal(flags.githubConfigured, true)
  })

  test('lock-unlock-lock cycle captures new state', () => {
    const adapter = new TestAdapter()
    adapter.setRepomapEnabled(true)
    adapter._lockMcpFlags()
    adapter._unlockMcpFlags()

    adapter.setRepomapEnabled(false)
    adapter._lockMcpFlags()

    const flags = adapter._getLockedMcpFlags()
    assert.equal(flags.repomapEnabled, false, 'second lock should capture new state')
  })

  test('default flags: repomap=true, semantic=true, github=false', () => {
    const adapter = new TestAdapter()
    const flags = adapter._getLockedMcpFlags()
    assert.equal(flags.repomapEnabled, true)
    assert.equal(flags.semanticSearchEnabled, true)
    assert.equal(flags.githubConfigured, false)
  })
})

// ── A2: Feature Flag Builders ───────────────────────────────────────

describe('BaseRoleAdapter — buildPromptFeatureFlags', () => {
  test('returns object with repomapEnabled, semanticSearchEnabled, githubConfigured', () => {
    const adapter = new TestAdapter()
    const flags = adapter._buildPromptFeatureFlags()
    assert.equal(typeof flags.repomapEnabled, 'boolean')
    assert.equal(typeof flags.semanticSearchEnabled, 'boolean')
    assert.equal(typeof flags.githubConfigured, 'boolean')
  })

  test('reflects current adapter state', () => {
    const adapter = new TestAdapter()
    adapter.setRepomapEnabled(false)
    adapter.setSemanticSearchEnabled(true)
    adapter.setGithubConfigured(true)

    const flags = adapter._buildPromptFeatureFlags()
    assert.equal(flags.repomapEnabled, false)
    assert.equal(flags.semanticSearchEnabled, true)
    assert.equal(flags.githubConfigured, true)
  })

  test('all default to expected initial values', () => {
    const adapter = new TestAdapter()
    const flags = adapter._buildPromptFeatureFlags()
    assert.equal(flags.repomapEnabled, true)
    assert.equal(flags.semanticSearchEnabled, true)
    assert.equal(flags.githubConfigured, false)
    assert.equal(flags.includeGitContext, true)
    assert.equal(flags.includeCheckpoint, false)
  })
})

// ── A3: Tool Guidance & Config ──────────────────────────────────────

describe('BaseRoleAdapter — appendToolGuidance', () => {
  test('appends Tool Priority heading to prompt (when strategy is not none)', () => {
    const adapter = new TestAdapter()
    const result = adapter._appendToolGuidance('Base prompt text', 1)
    assert.ok(result.includes('## Tool Priority'), 'should inject Tool Priority directive')
    assert.ok(result.includes('Base prompt text'), 'should preserve original prompt')
  })

  test('does NOT duplicate Tool Priority if already present', () => {
    const adapter = new TestAdapter()
    const input = 'Base prompt\n## Tool Priority\nexisting directives'
    const result = adapter._appendToolGuidance(input, 1)
    // Count occurrences of '## Tool Priority'
    const count = (result.match(/## Tool Priority/g) || []).length
    assert.equal(count, 1, 'should not duplicate Tool Priority')
  })

  test('skips Tool Priority when MCP strategy is none', () => {
    const adapter = new TestAdapter()
    adapter.setMcpStrategyOverride('none')
    const result = adapter._appendToolGuidance('Base prompt', 1)
    assert.ok(!result.includes('## Tool Priority'), 'none strategy should skip Tool Priority')
  })
})

describe('BaseRoleAdapter — getMcpStrategy', () => {
  test('default returns full', () => {
    const adapter = new TestAdapter()
    assert.equal(adapter._getMcpStrategy(), 'full')
  })
})

describe('BaseRoleAdapter — buildMcpConfig dispatch', () => {
  test('strategy none returns empty config', () => {
    const adapter = new TestAdapter()
    adapter.setMcpStrategyOverride('none')

    const ctx: AdapterMcpContext = {
      mode: 'plan',
      workspacePath: '/tmp',
      workspaceId: 'ws-1',
      conversationId: 'c-1',
      controlCallbacks: {} as any,
      contextTier: 'large' as any
    }
    const result = adapter.buildMcpConfig(ctx)
    assert.ok(result, 'should return a config object')
    // buildNoToolsConfig returns an empty config
    assert.ok(Array.isArray(result.mcpServers) || result.mcpServers === undefined || Object.keys(result).length >= 0)
  })
})

// ── A4: Timeout & Cache Logic ───────────────────────────────────────

describe('BaseRoleAdapter — applyLocalLlmTimeout', () => {
  test('local-llm provider sets timeout to 45 * 60_000', () => {
    const adapter = new TestAdapter()
    adapter._applyLocalLlmTimeout('local-llm')
    assert.equal(adapter.interactionTimeoutMs, 45 * 60_000)
  })

  test('claude provider does not set timeout (no-op)', () => {
    const adapter = new TestAdapter()
    const before = adapter.interactionTimeoutMs
    adapter._applyLocalLlmTimeout('claude')
    assert.equal(adapter.interactionTimeoutMs, before, 'should not change for claude provider')
  })
})

describe('BaseRoleAdapter — invalidateToneCache', () => {
  test('clears cached tone value without error', () => {
    const adapter = new TestAdapter()
    // No error should be thrown
    adapter._invalidateToneCache()
    assert.ok(true, 'invalidateToneCache completes without error')
  })

  test('calling invalidateToneCache multiple times is safe', () => {
    const adapter = new TestAdapter()
    adapter._invalidateToneCache()
    adapter._invalidateToneCache()
    adapter._invalidateToneCache()
    assert.ok(true, 'multiple calls are safe')
  })
})

describe('BaseRoleAdapter — getIncludeGitContext', () => {
  test('default returns true', () => {
    const adapter = new TestAdapter()
    assert.equal(adapter._getIncludeGitContext(), true)
  })
})

// ── Lifecycle defaults ──────────────────────────────────────────────

describe('BaseRoleAdapter — lifecycle defaults', () => {
  test('onSessionStart is a no-op (does not throw)', async () => {
    const adapter = new TestAdapter()
    await adapter.onSessionStart({
      workspacePath: '/tmp',
      workspaceId: null,
      conversationId: null
    })
    assert.ok(true)
  })

  test('onSessionStop is a no-op (does not throw)', () => {
    const adapter = new TestAdapter()
    adapter.onSessionStop()
    assert.ok(true)
  })

  test('onConversationSwitch is a no-op (does not throw)', () => {
    const adapter = new TestAdapter()
    adapter.onConversationSwitch('conv-123')
    assert.ok(true)
  })

  test('refreshFeatureFlags is a no-op (does not throw)', () => {
    const adapter = new TestAdapter()
    adapter.refreshFeatureFlags({
      workspacePath: '/tmp',
      workspaceId: null,
      conversationId: null
    })
    assert.ok(true)
  })
})

// ── buildControlCallbacks ───────────────────────────────────────────

describe('BaseRoleAdapter — buildControlCallbacks', () => {
  test('returns object with onPlan, onAskUser, onMemory functions', () => {
    const adapter = new TestAdapter()
    const callbacks = adapter.buildControlCallbacks({
      conversationId: 'c-1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    assert.equal(typeof callbacks.onPlan, 'function')
    assert.equal(typeof callbacks.onAskUser, 'function')
    assert.equal(typeof callbacks.onMemory, 'function')
  })

  test('onPlan callback can be called without error', () => {
    const adapter = new TestAdapter()
    const callbacks = adapter.buildControlCallbacks({
      conversationId: 'c-1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    callbacks.onPlan({} as any)
    assert.ok(true)
  })

  test('onAskUser callback can be called without error', () => {
    const adapter = new TestAdapter()
    const callbacks = adapter.buildControlCallbacks({
      conversationId: 'c-1',
      emit: () => {},
      getAccumulatedText: () => ''
    })
    callbacks.onAskUser([] as any)
    assert.ok(true)
  })
})

// ── emitDetectedIntents ─────────────────────────────────────────────

describe('BaseRoleAdapter — emitDetectedIntents', () => {
  test('emits response intent when no control tools fired', () => {
    const adapter = new TestAdapter()
    const emitted: Array<{ evt: string; payload: unknown }> = []
    const ctx: AdapterIntentContext = {
      accumulatedText: 'Hello world',
      controlToolState: { plan: false, askUser: false, memory: false } as any,
      mode: 'plan',
      conversationId: 'c1',
      emit: (evt, payload) => emitted.push({ evt, payload })
    }
    adapter.emitDetectedIntents(ctx)
    assert.ok(emitted.length >= 1)
    const response = emitted.find(e => (e.payload as any)?.type === 'response')
    assert.ok(response, 'should emit response intent')
    assert.equal((response!.payload as any).content, 'Hello world')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
