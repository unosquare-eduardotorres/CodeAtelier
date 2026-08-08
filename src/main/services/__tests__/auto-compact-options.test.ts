/**
 * Run 17: Auto-compact executor options — AgentExecutorFactory.buildCLIExecuteOptions.
 *
 * Verifies the compaction-relevant options the factory emits for Claude CLI
 * sessions, on BOTH the new-spawn path and the continueSession fast path:
 *   - autoCompactEnabled: true
 *   - contextWindowSize: full window for 1M models, 80% (160000) for 200K models
 *   - betas includes the 1M beta only for 1M models that are ALSO entitled to it
 *     (the beta header is API-key-only; see canUseContext1MBeta)
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
import { SESSION_CONSTANTS } from '../agent-session-host'
import type { SpawnSignature } from '../cli-executor'

const CONTEXT_1M_BETA = 'context-1m-2025-08-07'

interface MockHost {
  workspacePath: string
  workspaceId: string | null
  currentConversationId: string | null
  currentMode: string
  effectiveContextWindow: number
  adapter: { role: string; agentId: string }
  cliExecutor: { isAlive: () => boolean; getSpawnSignature: () => SpawnSignature | null }
  log: {
    info: (...a: unknown[]) => void
    warn: (...a: unknown[]) => void
    error: (...a: unknown[]) => void
  }
}

/**
 * @param model     the model the factory will resolve — needed to build a
 *                  matching default signature (effort mirrors resolveEffort's
 *                  model default: haiku → medium, everything else → high).
 * @param signature the live process's argv-baked flags. Defaults to one that
 *                  satisfies the desired signature, so `alive: true` means
 *                  "reusable" unless a test deliberately says otherwise.
 */
function makeHost(opts: {
  alive: boolean
  model?: string
  signature?: SpawnSignature | null
}): MockHost {
  const signature =
    opts.signature === undefined
      ? {
          model: opts.model,
          maxTurns: SESSION_CONSTANTS.CLI_MAX_TURNS,
          effort: opts.model?.includes('haiku') ? 'medium' : 'high'
        }
      : opts.signature
  return {
    workspacePath: '/test/ws',
    workspaceId: null, // skips additionalDirectories lookup
    currentConversationId: null, // skips conversation-repo lookups (effort/thinking budget)
    currentMode: 'plan',
    effectiveContextWindow: 0,
    adapter: { role: 'specialist', agentId: 'da-vinci-test' },
    cliExecutor: {
      isAlive: () => opts.alive,
      getSpawnSignature: () => signature
    },
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

/**
 * Build options with getModel stubbed to `model` for the duration of the (sync)
 * call, and with 1M-beta entitlement pinned via env.
 *
 * The entitlement env MUST be pinned explicitly: the ambient shell may or may
 * not carry ANTHROPIC_API_KEY, which would otherwise flip every 1M assertion.
 */
function buildWith(
  model: string,
  host: MockHost,
  params: BuildParams,
  entitlement: 'entitled' | 'not-entitled' = 'entitled'
): ReturnType<AgentExecutorFactory['buildCLIExecuteOptions']> {
  const orig = svc.getModel
  const origKey = process.env.ANTHROPIC_API_KEY
  const origFlag = process.env.CODE_ATELIER_CONTEXT_1M
  svc.getModel = () => model
  delete process.env.ANTHROPIC_API_KEY
  process.env.CODE_ATELIER_CONTEXT_1M = entitlement === 'entitled' ? '1' : '0'
  try {
    return makeFactory(host).buildCLIExecuteOptions(params)
  } finally {
    svc.getModel = orig
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = origKey
    if (origFlag === undefined) delete process.env.CODE_ATELIER_CONTEXT_1M
    else process.env.CODE_ATELIER_CONTEXT_1M = origFlag
  }
}

describe('buildCLIExecuteOptions — new-spawn path', () => {
  test('1M model: auto-compact, full window, 1M beta, env window=1000000, pct override=75', () => {
    const opts = buildWith('claude-opus-4-8', makeHost({ alive: false }), baseParams())
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.continueSession, false)
    assert.equal(opts.contextWindowSize, 1_000_000)
    assert.ok(opts.betas?.includes(CONTEXT_1M_BETA), '1M beta should be present')
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })

  test('200K model: auto-compact, window=160000, no 1M beta, pct override=75', () => {
    const opts = buildWith('claude-haiku-4-5', makeHost({ alive: false }), baseParams())
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.betas, undefined, '200K model should not request the 1M beta')
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })
})

describe('buildCLIExecuteOptions — 1M beta entitlement', () => {
  // Regression: supportsContext1M is a MODEL capability, not a login entitlement.
  // On a subscription login the CLI drops --betas, so a 1M-sized auto-compact
  // window can never fire against the real 200K ceiling and the turn overflows
  // with no output at all.
  test('sonnet without an API key: no betas, window sized to 200K', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({ alive: false }),
      baseParams(),
      'not-entitled'
    )
    assert.equal(opts.betas, undefined, 'unentitled login must not request the 1M beta')
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
  })

  test('sonnet with entitlement: betas present, window sized to 1M', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({ alive: false }),
      baseParams(),
      'entitled'
    )
    assert.ok(opts.betas?.includes(CONTEXT_1M_BETA), 'entitled login should request the 1M beta')
    assert.equal(opts.contextWindowSize, 1_000_000)
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
  })

  test('unentitled sonnet on the continueSession fast path also gets the 200K window', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({ alive: true, model: 'claude-sonnet-4-6' }),
      baseParams({ sessionId: 'session-abcdef12' }),
      'not-entitled'
    )
    assert.equal(opts.continueSession, true)
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '200000')
  })
})

describe('buildCLIExecuteOptions — continueSession fast path', () => {
  test('1M model + alive process + sessionId → continueSession with auto-compact + env', () => {
    const opts = buildWith(
      'claude-opus-4-8',
      makeHost({ alive: true, model: 'claude-opus-4-8' }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, true)
    assert.equal(opts.autoCompactEnabled, true)
    assert.equal(opts.contextWindowSize, 1_000_000)
    assert.equal(opts.envOverrides?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000')
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })

  test('200K model on fast path shrinks window and sets pct override', () => {
    const opts = buildWith(
      'claude-haiku-4-5',
      makeHost({ alive: true, model: 'claude-haiku-4-5' }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, true)
    assert.equal(opts.contextWindowSize, 160_000)
    assert.equal(opts.envOverrides?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '75')
  })
})

// Regression (Defect A): a maxTurns:1 recovery nudge respawned the SHARED
// executor, and every later turn reused that process over stdin — inheriting
// --max-turns 1 --effort low for 14 minutes. The fix is here rather than in
// cli-executor because only this path can build full respawn options.
describe('buildCLIExecuteOptions — spawn-signature reuse guard', () => {
  test('alive + sessionId + matching signature → reuses the process', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({ alive: true, model: 'claude-sonnet-4-6' }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, true)
  })

  test('alive + sessionId + a maxTurns:1/effort:low signature → respawns WITH resume', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({
        alive: true,
        signature: { model: 'claude-sonnet-4-6', maxTurns: 1, effort: 'low' }
      }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, false, 'a 1-turn process cannot serve a 200-turn budget')
    // The regression that matters most: respawning without --resume would lose
    // the conversation — strictly worse than the bug being fixed.
    assert.equal(opts.resume, 'session-abcdef12')
    assert.equal(opts.maxTurns, SESSION_CONSTANTS.CLI_MAX_TURNS)
    assert.equal(opts.effort, 'high')
  })

  test('alive + sessionId but no live signature → respawns', () => {
    const opts = buildWith(
      'claude-sonnet-4-6',
      makeHost({ alive: true, signature: null }),
      baseParams({ sessionId: 'session-abcdef12' })
    )
    assert.equal(opts.continueSession, false)
    assert.equal(opts.resume, 'session-abcdef12')
  })
})

// Regression (Defect B): --max-turns used to be `isBuildMode ? 200 : 50`, which
// made the signature mode-sensitive — every plan⇄build toggle forced a respawn
// and a full MCP reconnection. Mode-aware limiting lives in the circuit breaker.
describe('buildCLIExecuteOptions — maxTurns is mode-independent', () => {
  for (const isBuildMode of [true, false]) {
    test(`new-spawn path emits maxTurns=${SESSION_CONSTANTS.CLI_MAX_TURNS} (isBuildMode=${isBuildMode})`, () => {
      const opts = buildWith(
        'claude-sonnet-4-6',
        makeHost({ alive: false }),
        baseParams({ isBuildMode })
      )
      assert.equal(opts.maxTurns, SESSION_CONSTANTS.CLI_MAX_TURNS)
    })

    test(`fast path declares maxTurns=${SESSION_CONSTANTS.CLI_MAX_TURNS} (isBuildMode=${isBuildMode})`, () => {
      const opts = buildWith(
        'claude-sonnet-4-6',
        makeHost({ alive: true, model: 'claude-sonnet-4-6' }),
        baseParams({ sessionId: 'session-abcdef12', isBuildMode })
      )
      assert.equal(opts.continueSession, true, 'a mode toggle must not force a respawn')
      assert.equal(opts.maxTurns, SESSION_CONSTANTS.CLI_MAX_TURNS)
    })
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
