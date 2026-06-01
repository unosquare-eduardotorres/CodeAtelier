/**
 * Run 17: Auto-compact executor options — AgentExecutorFactory.buildCLIExecuteOptions.
 *
 * Verifies the compaction-relevant options the factory emits for Claude CLI
 * sessions, on BOTH the new-spawn path and the continueSession fast path:
 *   - autoCompactEnabled: true
 *   - contextWindowSize: full window for 1M models, 80% (160000) for 200K models
 *   - betas includes the 1M beta only for 1M models (new-spawn path)
 *   - envOverrides wire CLAUDE_CODE_AUTO_COMPACT_WINDOW (+ PCT override for 200K)
 *
 * modelConfigService.getModel is stubbed synchronously WITHIN each test body
 * (the harness runs hook-bearing tests concurrently, so beforeEach/afterEach
 * mutations to the shared singleton would race). buildCLIExecuteOptions is
 * synchronous, so the stub is valid for the whole call.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AgentExecutorFactory } from '../agent-executor-factory'
import { modelConfigService } from '../model-config.service'

const CONTEXT_1M_BETA = 'context-1m-2025-08-07'

interface MockHost {
  workspacePath: string
  workspaceId: string | null
  currentConversationId: string | null
  currentMode: string
  effectiveContextWindow: number
  adapter: { role: string; agentId: string }
  cliExecutor: { isAlive: () => boolean }
  log: {
    info: (...a: unknown[]) => void
    warn: (...a: unknown[]) => void
    error: (...a: unknown[]) => void
  }
}

function makeHost(opts: { alive: boolean }): MockHost {
  return {
    workspacePath: '/test/ws',
    workspaceId: null, // skips additionalDirectories lookup
    currentConversationId: null, // skips conversation-repo lookups (effort/thinking budget)
    currentMode: 'plan',
    effectiveContextWindow: 0,
    adapter: { role: 'da-vinci', agentId: 'da-vinci-test' },
    cliExecutor: { isAlive: () => opts.alive },
    log: { info: () => {}, warn: () => {}, error: () => {} }
  }
}

type BuildParams = Parameters<AgentExecutorFactory['buildCLIExecuteOptions']>[0]

function baseParams(overrides: Partial<BuildParams> = {}): BuildParams {
  return {
    prompt: 'hello',
    systemPrompt: 'SYS',
    sessionId: undefined,
    isBuildMode: false,
    resumeAt: undefined,
    abortController: new AbortController(),
    mcpResult: { mcpServers: {}, allowedTools: [], disallowedTools: [] },
    ...overrides
  } as BuildParams
}

function makeFactory(host: MockHost): AgentExecutorFactory {
  const factory = new AgentExecutorFactory(host as unknown as object)
  // Stub the heavy MCP-config write on the new-spawn path.
  ;(factory as unknown as { buildCLIMcpConfigPath: () => string }).buildCLIMcpConfigPath = () =>
    '/tmp/mock-mcp.json'
  return factory
}

const svc = modelConfigService as unknown as Record<string, unknown>

/** Build options with getModel stubbed to `model` for the duration of the (sync) call. */
function buildWith(
  model: string,
  host: MockHost,
  params: BuildParams
): ReturnType<AgentExecutorFactory['buildCLIExecuteOptions']> {
  const orig = svc.getModel
  svc.getModel = () => model
  try {
    return makeFactory(host).buildCLIExecuteOptions(params)
  } finally {
    svc.getModel = orig
  }
}

describe('buildCLIExecuteOptions — new-spawn path', () => {
  test('1M model: auto-compact, full window, 1M beta, env window=1000000, no pct override', () => {
    const opts = buildWith('claude-opus-4-8', makeHost({ alive: false }), baseParams())
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.continueSession, false)
    assert.equal(opts.contextWindowSize, 1_000_000)
    assert.ok(opts.betas?.includes(CONTEXT_1M_BETA), '1M beta should be present')
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined)
  })

  test('200K model: auto-compact, window=160000, no 1M beta, pct override=80', () => {
    const opts = buildWith('claude-haiku-4-5', makeHost({ alive: false }), baseParams())
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.betas, undefined, '200K model should not request the 1M beta')
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80')
  })
})

describe('buildCLIExecuteOptions — continueSession fast path', () => {
  test('1M model + alive process + sessionId → continueSession with auto-compact + env', () => {
    const opts = buildWith(
      'claude-opus-4-8',
      makeHost({ alive: true }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, true)
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.contextWindowSize, 1_000_000)
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
  })

  test('200K model on fast path shrinks window and sets pct override', () => {
    const opts = buildWith(
      'claude-haiku-4-5',
      makeHost({ alive: true }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, true)
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '80')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
