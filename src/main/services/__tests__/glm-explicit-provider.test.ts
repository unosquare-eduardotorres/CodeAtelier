/**
 * GLM remediation — explicit provider routing and provider-aware cost.
 *
 * Both defects covered here shared one root cause: the unit suite supplied a value by
 * hand that production supplies as NULL or as a workspace default.
 *
 *  #1 — The Grill/Council/Audit provider toggle was decorative. Those flows have no
 *       conversation row, so provider config fell back to `settings.llmProvider`.
 *       Picking "GLM" on a Claude workspace ran OpenCode against Anthropic.
 *
 *  #2 — `getWorkspaceCostSummary` priced GLM tokens off `agent_sessions.model_used`.
 *       That column is NULL for every production row, so the GLM guard never fired and
 *       the dashboard reported invented Sonnet dollars. The tests below deliberately
 *       leave `modelUsed` NULL — that is the production shape.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

// ── Repository stubs (patched in place on the singletons) ────────────

type Settings = Record<string, unknown>

let settingsByPath = new Map<string, Settings>()
let settingsById = new Map<string, Settings>()
let sessionsByWorkspace = new Map<string, unknown[]>()

let repos: any = null
let modelConfig: any = null
let snapshotResolver: any = null
let costTracker: any = null
let loaded = false

// The repositories are process-wide singletons and every test file shares this
// process. Originals are captured here and restored at the bottom of the file —
// leaving the stubs in place silently breaks whichever files load after this one.
const originals: Record<string, unknown> = {}

try {
  repos = require('../../db/repositories')

  originals.getSettingsByPath = repos.workspaceRepository.getSettingsByPath
  originals.getSettings = repos.workspaceRepository.getSettings
  originals.findByWorkspace = repos.agentSessionRepository.findByWorkspace
  originals.getTokenSummary = repos.agentSessionRepository.getTokenSummary

  repos.workspaceRepository.getSettingsByPath = (p: string) => settingsByPath.get(p) ?? {}
  repos.workspaceRepository.getSettings = (id: string) => settingsById.get(id) ?? {}

  repos.agentSessionRepository.findByWorkspace = (id: string) => sessionsByWorkspace.get(id) ?? []
  repos.agentSessionRepository.getTokenSummary = (id: string) => {
    const sessions = (sessionsByWorkspace.get(id) ?? []) as any[]
    return {
      totalTokens: sessions.reduce((s, x) => s + (x.tokenUsage ?? 0), 0),
      sessionCount: sessions.length,
      totalInputTokens: sessions.reduce((s, x) => s + (x.inputTokens ?? 0), 0),
      totalOutputTokens: sessions.reduce((s, x) => s + (x.outputTokens ?? 0), 0),
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalTurns: 0
    }
  }

  modelConfig = require('../model-config.service')
  snapshotResolver = require('../snapshot-model-resolver')
  costTracker = require('../cost-tracker.service')
  loaded = true
} catch (err) {
  console.log('⚠ glm-explicit-provider: module load failed — tests skipped.')
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

/** A production agent_sessions row: model_used is NULL, nothing ever writes it. */
function session(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 's1',
    agentType: 'specialist',
    tokenUsage: 1_000_000,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelUsed: null,
    ...over
  }
}

if (loaded) {
  // ── #1: explicit provider beats the workspace default ──────────────

  describe('getOpenCodeConfig — explicit provider override', () => {
    const CLAUDE_WS = '/repo/claude-ws'

    test('without an override, a Claude workspace still resolves to anthropic', () => {
      settingsByPath = new Map([[CLAUDE_WS, { llmProvider: 'claude' }]])
      const config = modelConfig.modelConfigService.getOpenCodeConfig(CLAUDE_WS)
      assert.equal(config.openCodeProvider, 'anthropic')
    })

    /**
     * The Grill bug in one assertion: same workspace, same settings, explicit GLM.
     * Before the fix this returned `anthropic` / `claude-sonnet-5`.
     */
    test('an explicit glm override routes a Claude workspace to glm', () => {
      settingsByPath = new Map([
        [
          CLAUDE_WS,
          {
            llmProvider: 'claude',
            glmBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
            glmModel: 'glm-5.3'
          }
        ]
      ])
      const config = modelConfig.modelConfigService.getOpenCodeConfig(CLAUDE_WS, 'glm')
      assert.equal(config.openCodeProvider, 'glm')
      assert.equal(config.openCodeModel, 'glm-5.3')
      assert.equal(config.openCodeBaseUrl, 'https://api.z.ai/api/coding/paas/v4')
    })

    test('an explicit local-llm override routes a Claude workspace to ollama', () => {
      settingsByPath = new Map([[CLAUDE_WS, { llmProvider: 'claude', localModel: 'qwen3:8b' }]])
      const config = modelConfig.modelConfigService.getOpenCodeConfig(CLAUDE_WS, 'local-llm')
      assert.equal(config.openCodeProvider, 'ollama')
      assert.equal(config.openCodeModel, 'qwen3:8b')
    })

    /** The override is symmetric — it is not a one-way "upgrade to GLM" hook. */
    test('an explicit claude override on a GLM workspace resolves to anthropic', () => {
      const GLM_WS = '/repo/glm-ws'
      settingsByPath = new Map([[GLM_WS, { llmProvider: 'glm', glmModel: 'glm-5.3' }]])
      const config = modelConfig.modelConfigService.getOpenCodeConfig(GLM_WS, 'claude')
      assert.equal(config.openCodeProvider, 'anthropic')
    })
  })

  describe('resolveOpenCodeProviderFromSnapshot — override on the fallback path', () => {
    const CLAUDE_WS = '/repo/claude-ws-2'

    /** Grill passes a synthetic conversation id that has no row, so this is the live path. */
    test('a null conversation with a glm override resolves to glm', () => {
      settingsByPath = new Map([
        [CLAUDE_WS, { llmProvider: 'claude', glmModel: 'glm-5.3', glmContextLimit: 200_000 }]
      ])
      const config = snapshotResolver.resolveOpenCodeProviderFromSnapshot(
        null,
        CLAUDE_WS,
        false,
        'glm'
      )
      assert.equal(config.providerId, 'glm')
      assert.equal(config.modelId, 'glm-5.3')
      // The limits must survive the hop — a narrowed return type used to drop them.
      assert.equal(config.contextLimit, 200_000)
    })

    test('a null conversation with no override keeps the workspace provider', () => {
      settingsByPath = new Map([[CLAUDE_WS, { llmProvider: 'claude' }]])
      const config = snapshotResolver.resolveOpenCodeProviderFromSnapshot(null, CLAUDE_WS, false)
      assert.equal(config.providerId, 'anthropic')
    })
  })

  // ── #1: the toggle reaches the session through the adapter ──────

  describe('role adapters — explicit provider is readable by the session', () => {
    /**
     * `AgentSessionService.start()` duck-types `getLlmProvider()`. Adapters store
     * `llmProvider ?? 'claude'` for timeouts, which is NOT the same value: returning
     * that would override a GLM workspace back to Claude whenever no toggle was used.
     */
    test('an explicit provider is exposed; an absent one stays undefined', () => {
      const { GrillRoleAdapter } = require('../role-adapters/grill.adapter')
      const base = { workspaceId: 'ws-1', trackId: 'market', ideaTitle: 't', ideaDescription: 'd' }

      const explicit = new GrillRoleAdapter({ ...base, llmProvider: 'glm' })
      assert.equal(explicit.getLlmProvider(), 'glm')

      const implicit = new GrillRoleAdapter(base)
      assert.equal(implicit.getLlmProvider(), undefined)
    })
  })

  // ── End-to-end: resolved config → opencode.json actually on disk ──

  describe('explicit GLM selection reaches the generated opencode.json', () => {
    /**
     * The gap this closes: every previous GLM escape passed unit tests because each
     * hop was asserted in isolation. This drives the real resolver output through the
     * real config writer and reads the file back off disk.
     */
    test('the written config names glm, with its verbatim base URL and limits', () => {
      const WS = '/repo/glm-e2e-ws'
      settingsByPath = new Map([
        [
          WS,
          {
            llmProvider: 'claude', // workspace default — deliberately NOT glm
            glmBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
            glmModel: 'glm-5.3',
            glmApiKey: 'zai-plaintext-key',
            glmContextLimit: 200_000
          }
        ]
      ])

      const { OpenCodeConfigWriter } = require('../opencode-config-writer')
      const writer = new OpenCodeConfigWriter()

      const provider = snapshotResolver.resolveOpenCodeProviderFromSnapshot(null, WS, false, 'glm')
      const configPath = writer.writeConfig({
        workspacePath: WS,
        workspaceId: 'ws-glm-e2e',
        conversationId: null,
        mode: 'plan',
        provider,
        featureFlags: {
          repomapEnabled: false,
          semanticSearchEnabled: false,
          githubConfigured: false,
          localMcpActive: {}
        }
      })

      const written = JSON.parse(readFileSync(configPath, 'utf-8'))
      assert.ok(written.model.startsWith('glm/'), `expected a glm model, got ${written.model}`)
      assert.equal(written.provider.glm.options.baseURL, 'https://api.z.ai/api/coding/paas/v4')
      assert.ok(!written.provider.anthropic, 'anthropic must not be configured for a GLM run')

      // GLM-P2: the file holds a plaintext key — disposeAll() must remove it.
      writer.disposeAll()
      assert.equal(existsSync(configPath), false, 'disposeAll must delete the config file')
    })
  })

  // ── #2: cost summary is provider-aware, not model_used-aware ───────

  describe('getWorkspaceCostSummary — GLM workspaces report no dollars', () => {
    test('a GLM workspace reports zero cost even though model_used is NULL', () => {
      settingsById = new Map([['ws-glm', { llmProvider: 'glm' }]])
      sessionsByWorkspace = new Map([['ws-glm', [session()]]])

      const summary = costTracker.costTrackerService.getWorkspaceCostSummary('ws-glm')
      assert.equal(summary.totalCostCents, 0)
      assert.equal(summary.byAgent[0].costCents, 0)
    })

    test('tokens are still counted — only the dollar figure is suppressed', () => {
      settingsById = new Map([['ws-glm', { llmProvider: 'glm' }]])
      sessionsByWorkspace = new Map([['ws-glm', [session()]]])

      const summary = costTracker.costTrackerService.getWorkspaceCostSummary('ws-glm')
      assert.equal(summary.totalTokens, 1_000_000)
      assert.equal(summary.sessionCount, 1)
      assert.equal(summary.byAgent[0].tokens, 1_000_000)
    })

    /** The guard must not swallow real Claude spend. */
    test('a Claude workspace with the same NULL model_used still reports cost', () => {
      settingsById = new Map([['ws-claude', { llmProvider: 'claude' }]])
      sessionsByWorkspace = new Map([['ws-claude', [session()]]])

      const summary = costTracker.costTrackerService.getWorkspaceCostSummary('ws-claude')
      // 1M in + 1M out at the default $3/$15 split.
      assert.equal(summary.totalCostCents, 1800)
    })

    test('a workspace with no settings row is treated as billable, not free', () => {
      settingsById = new Map()
      sessionsByWorkspace = new Map([['ws-unknown', [session()]]])

      const summary = costTracker.costTrackerService.getWorkspaceCostSummary('ws-unknown')
      assert.ok(summary.totalCostCents > 0)
    })
  })
}

// Restore the real repository methods before the next test file loads.
if (repos) {
  repos.workspaceRepository.getSettingsByPath = originals.getSettingsByPath
  repos.workspaceRepository.getSettings = originals.getSettings
  repos.agentSessionRepository.findByWorkspace = originals.findByWorkspace
  repos.agentSessionRepository.getTokenSummary = originals.getTokenSummary
}

// Only print + exit when run standalone — summaryAsync() calls process.exit(), which
// would truncate the shared run-tests.ts process at this file.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
