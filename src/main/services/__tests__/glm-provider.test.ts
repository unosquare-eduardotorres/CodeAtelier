/**
 * GLM (Z.ai) provider integration — unit tests.
 *
 * These lock down the defects that made GLM unusable, each of which failed silently
 * rather than loudly:
 *
 *  D1 — the config writer appended `/v1` to every custom provider's base URL, turning
 *       `…/coding/paas/v4` into `…/v4/v1` (404) and mangling a user's proxy URL.
 *  D2 — the model declaration was gated on `isLocal`, so GLM got no `models` block at
 *       all; with no `tool_call` flag and no models.dev entry, tool calling degrades
 *       to plain chat with no error anywhere.
 *  D3 — no small model for GLM, so title generation ran on the frontier model at a
 *       24x output credit multiplier.
 *  D4 — GLM billing is credits, not dollars, and cached input (the dominant term)
 *       was not modelled at all.
 *
 * Plus the credit maths and the goal-condition sharing.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeConfigWriter } from '../opencode-config-writer'
import { estimateGlmCredits, isGlmOffPeak, buildGlmQuotaStatus } from '../glm-credits'
import { buildGlmRemoteMcpServers } from '../glm-mcp'
import { testGlmConnection } from '../glm-connection'
import {
  buildGoalPromptSection,
  goalEnforcementFor,
  sanitizeGoalCondition,
  GOAL_MAX_CHARS
} from '../goal-condition'
import {
  GLM_DEFAULT_CONTEXT_LIMIT,
  GLM_DEFAULT_OUTPUT_LIMIT,
  GLM_ENDPOINTS,
  GLM_PLAN_LIMITS,
  GLM_SMALL_MODEL_ID,
  GLM_MCP_CREDITS_PER_CALL
} from '../../../shared/constants'

const writer = new OpenCodeConfigWriter()

const glmProvider = {
  providerId: 'glm',
  modelId: 'glm-5.3',
  baseUrl: GLM_ENDPOINTS.codingOpenAI,
  apiKey: 'zai-test-key'
}

// ── D1: base URL is used verbatim ──

describe('GLM base URL (D1)', () => {
  /**
   * The whole failure mode in one assertion: the Coding Plan endpoint ends in `/v4`,
   * and appending `/v1` yields a 404 that looks like a broken key or a broken proxy.
   */
  test('Z.ai coding endpoint round-trips byte-identically', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, undefined)
    assert.equal(providers.glm.options.baseURL, GLM_ENDPOINTS.codingOpenAI)
  })

  test('a local proxy URL is not rewritten either', () => {
    const provider = { ...glmProvider, baseUrl: 'http://127.0.0.1:8080' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.equal(providers.glm.options.baseURL, 'http://127.0.0.1:8080')
  })

  test('a proxy URL with a path keeps its path', () => {
    const provider = { ...glmProvider, baseUrl: 'http://127.0.0.1:8080/glm/api' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.equal(providers.glm.options.baseURL, 'http://127.0.0.1:8080/glm/api')
  })

  /** The /v1 append still has to happen for the providers that actually need it. */
  test('local ollama still gets /v1 appended', () => {
    const provider = {
      providerId: 'ollama',
      modelId: 'qwen3:8b',
      baseUrl: 'http://localhost:11434'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium')
    assert.equal(providers.ollama.options.baseURL, 'http://localhost:11434/v1')
  })
})

// ── D2: the models block must exist for GLM ──

describe('GLM model declaration (D2)', () => {
  test('a cloud custom provider declares its model', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, undefined)
    assert.ok(providers.glm.models, 'glm must declare a models block')
    assert.ok(providers.glm.models['glm-5.3'], 'the active model must be declared')
  })

  /**
   * models.dev has no `glm/*` entry, so an undeclared model advertises no tool
   * calling — the agent quietly stops using tools instead of erroring.
   */
  test('capability flags are declared explicitly', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, undefined)
    const model = providers.glm.models['glm-5.3']
    assert.equal(model.tool_call, true)
    assert.equal(model.attachment, true)
    assert.equal(model.reasoning, true)
    assert.deepEqual(model.modalities.input, ['text', 'image'])
  })

  test('npm package is set for the custom provider', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, undefined)
    assert.equal(providers.glm.npm, '@ai-sdk/openai-compatible')
  })

  test('discovered limits win over the defaults', () => {
    const provider = { ...glmProvider, contextLimit: 128_000, outputLimit: 64_000 }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.deepEqual(providers.glm.models['glm-5.3'].limit, {
      context: 128_000,
      output: 64_000
    })
  })

  test('falls back to documented defaults when nothing was discovered', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, undefined)
    // Output is the documented hard cap: Z.ai's chat-completion reference gives
    // `max_tokens` a range of 1..131072. Context is an assumption, not a spec.
    assert.deepEqual(providers.glm.models['glm-5.3'].limit, {
      context: GLM_DEFAULT_CONTEXT_LIMIT,
      output: GLM_DEFAULT_OUTPUT_LIMIT
    })
    assert.equal(GLM_DEFAULT_OUTPUT_LIMIT, 131_072)
  })

  /** A cloud tier is not a local context tier — GLM limits must not be tier-derived. */
  test('a context tier does not shrink a cloud provider to local limits', () => {
    const providers = (writer as any).buildProviderConfig(glmProvider, false, 'small', true)
    assert.equal(providers.glm.models['glm-5.3'].limit.context, 200_000)
  })
})

// ── D3: housekeeping model ──

describe('GLM housekeeping model (D3)', () => {
  test('glm defaults to the Flash model', () => {
    assert.equal((writer as any).resolveSmallModel('glm'), `glm/${GLM_SMALL_MODEL_ID}`)
  })

  test('an explicit small model overrides the default', () => {
    assert.equal((writer as any).resolveSmallModel('glm', 'glm-5.3'), 'glm/glm-5.3')
  })

  /**
   * Empty string and undefined must not mean the same thing: '' is the user asking
   * for housekeeping OFF (credit-tight), undefined is "no preference".
   */
  test('an empty small model disables housekeeping entirely', () => {
    assert.equal((writer as any).resolveSmallModel('glm', ''), undefined)
  })

  test('undefined still yields the provider default', () => {
    assert.equal((writer as any).resolveSmallModel('glm', undefined), `glm/${GLM_SMALL_MODEL_ID}`)
  })
})

// ── D4: credit accounting ──

describe('GLM credits (D4)', () => {
  // Mon 2026-01-05 15:00 UTC+8 → 07:00 UTC. Inside the peak window.
  const peak = new Date('2026-01-05T07:00:00Z')
  // Same day, 20:00 UTC+8 → 12:00 UTC. Outside the peak window.
  const offPeak = new Date('2026-01-05T12:00:00Z')

  test('peak window is Mon–Fri 14:00–18:00 UTC+8', () => {
    assert.equal(isGlmOffPeak(peak), false)
    assert.equal(isGlmOffPeak(offPeak), true)
  })

  test('a weekend afternoon is off-peak', () => {
    // Sat 2026-01-10 15:00 UTC+8 → 07:00 UTC.
    assert.equal(isGlmOffPeak(new Date('2026-01-10T07:00:00Z')), true)
  })

  test('token credits follow the published multipliers', () => {
    // 10,000 fresh input on glm-5.3 = 6.9 credits at peak.
    const credits = estimateGlmCredits(
      { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 0 },
      'glm-5.3',
      peak
    )
    assert.equal(Math.round(credits * 100) / 100, 6.9)
  })

  /**
   * The single most important property of the whole cost model: cached input is
   * ~4x cheaper than fresh input, which is why prompt-prefix stability matters
   * more than any other lever.
   */
  test('cached input is billed at its own, much lower rate', () => {
    const fresh = estimateGlmCredits(
      { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 0 },
      'glm-5.3',
      peak
    )
    const cached = estimateGlmCredits(
      { inputTokens: 0, cachedInputTokens: 10_000, outputTokens: 0 },
      'glm-5.3',
      peak
    )
    assert.ok(cached < fresh / 3, `cached (${cached}) should be far below fresh (${fresh})`)
  })

  test('output is the most expensive term', () => {
    const input = estimateGlmCredits(
      { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 0 },
      'glm-5.3',
      peak
    )
    const output = estimateGlmCredits(
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 10_000 },
      'glm-5.3',
      peak
    )
    assert.ok(output > input * 3, 'output must cost several times input')
  })

  test('Flash is materially cheaper than the frontier model', () => {
    const usage = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 10_000 }
    const frontier = estimateGlmCredits(usage, 'glm-5.3', peak)
    const flash = estimateGlmCredits(usage, GLM_SMALL_MODEL_ID, peak)
    assert.ok(flash < frontier / 2)
  })

  test('off-peak halves the bill', () => {
    const usage = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 10_000 }
    assert.equal(
      estimateGlmCredits(usage, 'glm-5.3', offPeak),
      estimateGlmCredits(usage, 'glm-5.3', peak) / 2
    )
  })

  test('MCP tool calls are billed per call', () => {
    const credits = estimateGlmCredits(
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, mcpCalls: 5 },
      'glm-5.3',
      peak
    )
    assert.equal(credits, 5 * GLM_MCP_CREDITS_PER_CALL)
  })

  /**
   * Under-reporting a quota is worse than over-reporting: the failure mode is a
   * surprise 5-hour lockout mid-task.
   */
  test('an unknown model bills at the most expensive known rates', () => {
    const usage = { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 10_000 }
    assert.equal(
      estimateGlmCredits(usage, 'glm-9-unreleased', peak),
      estimateGlmCredits(usage, 'glm-5.3', peak)
    )
  })

  test('quota status reports both windows against the Max limits', () => {
    const status = buildGlmQuotaStatus(14_000, 70_000, peak)
    assert.equal(status.limit5h, GLM_PLAN_LIMITS.max.per5h)
    assert.equal(status.limitWeek, GLM_PLAN_LIMITS.max.perWeek)
    assert.equal(status.percentOf5h, 50)
    assert.equal(status.percentOfWeek, 50)
  })
})

// ── Remote MCP wiring (D7) ──

describe('GLM remote MCP servers (D7)', () => {
  test('nothing mounts when no server is enabled', () => {
    assert.equal(buildGlmRemoteMcpServers({}, 'key'), undefined)
    assert.equal(buildGlmRemoteMcpServers(undefined, 'key'), undefined)
  })

  /** These endpoints authenticate with a Bearer key; mounting without one guarantees failure. */
  test('nothing mounts without an API key', () => {
    assert.equal(buildGlmRemoteMcpServers({ 'web-search': true }, undefined), undefined)
  })

  test('an enabled server mounts with a Bearer header', () => {
    const servers = buildGlmRemoteMcpServers({ 'web-search': true }, 'zai-key')
    assert.ok(servers)
    const entry = servers!['web-search-prime']
    assert.ok(entry, 'web-search-prime must be present')
    assert.equal(entry.headers?.Authorization, 'Bearer zai-key')
    assert.ok(entry.url.startsWith('https://api.z.ai/'))
  })

  test('a disabled server stays unmounted while its sibling mounts', () => {
    const servers = buildGlmRemoteMcpServers({ 'web-search': true, 'web-reader': false }, 'k')
    assert.deepEqual(Object.keys(servers ?? {}), ['web-search-prime'])
  })

  /**
   * Vision is stdio (a registry integration), never a remote MCP entry. `vision`
   * was removed from `GlmMcpServerId`, but a workspace configured before that
   * removal can still have `{ vision: true }` persisted in settings_json — hence
   * the cast, and hence this test: the mounter must ignore ids it does not know
   * rather than fabricate a server entry with no URL.
   */
  test('vision is never mounted as a remote server', () => {
    const servers = buildGlmRemoteMcpServers({ vision: true } as never, 'k')
    assert.equal(servers, undefined)
  })
})

// ── Discovered model limits ──

describe('GLM /models limit discovery', () => {
  /** Probe a stubbed `/models` payload and hand back the parsed result. */
  async function probe(payload: unknown): Promise<import('../../../shared/types').GlmConnectionResult> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })) as typeof globalThis.fetch
    try {
      return await testGlmConnection('https://proxy.local/v1', 'k')
    } finally {
      globalThis.fetch = realFetch
    }
  }

  test('an ids-only response (Z.ai) reports no limits, so defaults stand', async () => {
    const result = await probe({ data: [{ id: 'glm-5.3' }, { id: 'glm-5.3-flash' }] })
    assert.deepEqual(result.models, ['glm-5.3', 'glm-5.3-flash'])
    assert.equal(result.modelLimits, undefined)
  })

  test('a proxy reporting context_length has it captured', async () => {
    const result = await probe({
      data: [{ id: 'glm-5.3', context_length: 131072, max_output_tokens: 65536 }]
    })
    assert.deepEqual(result.modelLimits?.['glm-5.3'], {
      contextLimit: 131072,
      outputLimit: 65536
    })
  })

  test('alternate field spellings are accepted', async () => {
    const result = await probe({ data: [{ id: 'm', context_window: 200000 }] })
    assert.equal(result.modelLimits?.m.contextLimit, 200000)
    assert.equal(result.modelLimits?.m.outputLimit, undefined)
  })

  test('a zero or negative limit is treated as absent, never persisted', () => {
    // Persisting 0 would hand OpenCode a zero-token window and wedge compaction.
    return probe({ data: [{ id: 'm', context_length: 0, max_output_tokens: -1 }] }).then(
      (result) => assert.equal(result.modelLimits, undefined)
    )
  })
})

// ── /goal parity (Phase 4) ──

describe('goal condition sharing', () => {
  test('whitespace is collapsed so both backends see one string', () => {
    assert.equal(sanitizeGoalCondition('  all\n\ttests   pass  '), 'all tests pass')
  })

  test('an empty condition yields null, not an empty goal section', () => {
    assert.equal(sanitizeGoalCondition('   \n  '), null)
    assert.equal(buildGoalPromptSection('   '), null)
  })

  test('a long condition is capped', () => {
    const condition = sanitizeGoalCondition('x'.repeat(GOAL_MAX_CHARS + 500))
    assert.equal(condition?.length, GOAL_MAX_CHARS)
  })

  test('the prompt section carries the condition verbatim', () => {
    const section = buildGoalPromptSection('all tests pass')
    assert.ok(section?.includes('## Completion Goal'))
    assert.ok(section?.includes('all tests pass'))
  })

  /**
   * Only the Claude CLI has the stop-hook evaluator. Reporting "enforced" on
   * OpenCode would promise a guarantee nothing in the app can keep.
   */
  test('only the CLI backend enforces a goal', () => {
    assert.equal(goalEnforcementFor('cli'), 'enforced')
    assert.equal(goalEnforcementFor('opencode'), 'advisory')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
