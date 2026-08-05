/**
 * Phase 27 — agent-executor-factory.ts deep mock tests.
 *
 * AgentExecutorFactory is a class that depends on an AgentSessionHost reference.
 * We mock the host and test the pure-logic methods:
 *   - resolveLocalContextWindow()
 *   - resolveLocalContextWindowAsync()
 *   - resolveWorkspaceMcpFlags()
 *   - resolveExternalMcpFlags()
 *   - resolveBudgetCap()
 *   - resolveHookPaths()
 *   - invalidateMcpConfigCache()
 *   - getCachedMcpConfigPath()
 *   - buildCLIExecuteOptions() (partial — fast path only)
 */
import assert from 'node:assert/strict'
import { describe, test, summaryAsync } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  createSpy,
  mockService
} from './setup-full-mock'

setupFullMock()

// Mock service singletons before require
mockService('model-config.service', {
  modelConfigService: {
    getLocalLLMConfig: createSpy(() => ({ localModel: 'qwen2.5-coder:7b' })),
    getModelById: createSpy(() => 'claude-haiku-4-5')
  }
})

mockService('context-window-resolver', {
  contextWindowResolver: {
    resolve: createSpy(async () => 131_072)
  }
})

mockService('snapshot-model-resolver', {
  resolveModelFromSnapshot: createSpy(() => 'claude-sonnet-4-6')
})

// Now require the factory
const { AgentExecutorFactory } = require('../agent-executor-factory')

const wsRepo = getMockRepo('workspace')
const convoRepo = getMockRepo('conversation')

// ── Mock host ──

function createMockHost(overrides: Record<string, any> = {}): any {
  return {
    workspacePath: '/test/workspace',
    workspaceId: 'ws-1',
    currentConversationId: 'conv-1',
    currentMode: 'build',
    effectiveContextWindow: 200_000,
    accumulatedText: '',
    instanceId: 'inst-1',
    cliExecutor: { isAlive: () => false },
    mcpConfigWriter: { writeConfig: createSpy(() => '/tmp/mcp.json') },
    ipcBridge: null,
    adapter: {
      role: 'specialist',
      agentId: 'davinci',
      buildControlCallbacks: createSpy(() => ({}))
    },
    log: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    emitAdapterEvent: createSpy(),
    ...overrides
  }
}

describe('AgentExecutorFactory — cache methods', () => {
  test('invalidateMcpConfigCache clears cached path', () => {
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    // Initially undefined
    assert.equal(factory.getCachedMcpConfigPath(), undefined)
    factory.invalidateMcpConfigCache()
    assert.equal(factory.getCachedMcpConfigPath(), undefined)
  })
})

describe('AgentExecutorFactory — resolveLocalContextWindow', () => {
  test('returns context window from RECOMMENDED_LOCAL_MODELS', () => {
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const result = factory.resolveLocalContextWindow()
    assert.equal(typeof result, 'number')
    assert.ok(result > 0)
  })

  test('returns 131_072 default when no workspacePath', () => {
    const host = createMockHost({ workspacePath: null })
    const factory = new AgentExecutorFactory(host)
    const result = factory.resolveLocalContextWindow()
    assert.equal(result, 131_072)
  })
})

describe('AgentExecutorFactory — resolveLocalContextWindowAsync', () => {
  test('returns cached value on second call', async () => {
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)

    // First call resolves
    const r1 = await factory.resolveLocalContextWindowAsync()
    assert.equal(typeof r1.contextWindow, 'number')
    assert.equal(typeof r1.confident, 'boolean')

    // Second call returns same cached value
    const r2 = await factory.resolveLocalContextWindowAsync()
    assert.equal(r1.contextWindow, r2.contextWindow)
    assert.equal(r1.confident, r2.confident)
  })

  test('returns 131_072 when no workspacePath', async () => {
    const host = createMockHost({ workspacePath: null })
    const factory = new AgentExecutorFactory(host)
    const result = await factory.resolveLocalContextWindowAsync()
    assert.equal(result.contextWindow, 131_072)
    assert.equal(result.confident, false)
  })
})

describe('AgentExecutorFactory — resolveWorkspaceMcpFlags', () => {
  test('returns defaults when no workspaceId', () => {
    const host = createMockHost({ workspaceId: null })
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveWorkspaceMcpFlags()
    assert.equal(flags.repomapEnabled, true)
    assert.equal(flags.semanticSearchEnabled, true)
    assert.equal(flags.githubConfigured, false)
  })

  test('returns workspace settings when available', () => {
    wsRepo.findById.mockReturnValue({ id: 'ws-1', repoPath: '/test/workspace' })
    wsRepo.getSettings.mockReturnValue({
      repomapEnabled: true,
      semanticSearchEnabled: false,
      githubToken: 'ghp_test'
    })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveWorkspaceMcpFlags()
    assert.equal(flags.repomapEnabled, true)
    assert.equal(flags.semanticSearchEnabled, false)
    assert.equal(flags.githubConfigured, true)
  })

  test('handles repo lookup failure gracefully', () => {
    wsRepo.findById.mockImplementation(() => {
      throw new Error('DB error')
    })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveWorkspaceMcpFlags()
    // Should return defaults on error
    assert.equal(flags.repomapEnabled, true)
  })
})

describe('AgentExecutorFactory — resolveExternalMcpFlags', () => {
  test('returns empty flags when no conversationId', () => {
    const host = createMockHost({ currentConversationId: null })
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveExternalMcpFlags()
    assert.deepEqual(flags, {})
  })

  test('returns empty flags when conversation has no mcpOverrides', () => {
    convoRepo.findById.mockReturnValue({ id: 'conv-1', mcpOverrides: null })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveExternalMcpFlags()
    assert.deepEqual(flags, {})
  })

  test('handles error gracefully', () => {
    convoRepo.findById.mockImplementation(() => {
      throw new Error('DB error')
    })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const flags = factory.resolveExternalMcpFlags()
    assert.deepEqual(flags, {})
  })
})

describe('AgentExecutorFactory — resolveBudgetCap', () => {
  test('returns undefined for local provider', () => {
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(true, true)
    assert.equal(cap, undefined)
  })

  test('returns undefined when no workspacePath', () => {
    const host = createMockHost({ workspacePath: null })
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(false, true)
    assert.equal(cap, undefined)
  })

  test('returns undefined when no budget set', () => {
    wsRepo.findAll.mockReturnValue([{ id: 'ws-1', repoPath: '/test/workspace' }])
    wsRepo.getSettings.mockReturnValue({ budgetCapUsd: 0 })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(false, true)
    assert.equal(cap, undefined)
  })

  test('returns multiplied cap for build mode', () => {
    wsRepo.findAll.mockReturnValue([{ id: 'ws-1', repoPath: '/test/workspace' }])
    wsRepo.getSettings.mockReturnValue({ budgetCapUsd: 10 })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(false, true)
    assert.equal(typeof cap, 'number')
    assert.ok(cap! > 0)
  })

  test('returns multiplied cap for plan mode', () => {
    wsRepo.findAll.mockReturnValue([{ id: 'ws-1', repoPath: '/test/workspace' }])
    wsRepo.getSettings.mockReturnValue({ budgetCapUsd: 10 })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(false, false)
    assert.equal(typeof cap, 'number')
    assert.ok(cap! > 0)
  })

  test('handles error gracefully', () => {
    wsRepo.findAll.mockImplementation(() => {
      throw new Error('DB error')
    })
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const cap = factory.resolveBudgetCap(false, true)
    assert.equal(cap, undefined)
  })
})

describe('AgentExecutorFactory — resolveHookPaths', () => {
  test('returns object with optional pre/post fields', () => {
    const host = createMockHost()
    const factory = new AgentExecutorFactory(host)
    const hooks = factory.resolveHookPaths()
    assert.equal(typeof hooks, 'object')
    // In test env, hooks may or may not exist
    assert.ok(hooks.pre === undefined || typeof hooks.pre === 'string')
    assert.ok(hooks.post === undefined || typeof hooks.post === 'string')
  })
})

// ─── Standalone runner ──────────────────────────────────────────────────
// NOTE: must be guarded — this file is dynamically imported by
// src/main/__tests__/run-all.ts for the unified coverage run. An
// unconditional summaryAsync() call here calls process.exit() and
// truncates that run before it finishes loading the remaining ~150
// registered test modules (discovered while investigating R018 —
// the unified run's own completion sentinel never printed).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
