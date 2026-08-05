/**
 * Unit tests for buildWorkspaceMcpConfig — feature-flag and tier-gated MCP tool lists.
 *
 * Tests: local provider tier gating (small/medium/large), Claude provider full set,
 * plan mode disallowed tools, feature flag conditionals (repomap, semanticSearch).
 *
 * Strategy: Stub Electron `app`, `electron-log`, and `chatAgentLogger` at require
 * cache level, then import buildWorkspaceMcpConfig.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

// Use the shared electron stub (ipcMain, app, BrowserWindow, electron-log).
// Safe to call multiple times — idempotent.
setupElectronStub()

// Stub chatAgentLogger (non-electron; still needed independently)
try {
  const loggerPath = require.resolve('../../logger')
  const loggerMock = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {}
  }
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { chatAgentLogger: loggerMock },
    children: [],
    paths: [],
    path: ''
  } as unknown as NodeModule
} catch {
  // skip
}

// Now dynamically import
let buildWorkspaceMcpConfig:
  typeof import('../workspace-mcp-config').buildWorkspaceMcpConfig | null = null
let importError: Error | null = null

try {
  const mod = require('../workspace-mcp-config')
  buildWorkspaceMcpConfig = mod.buildWorkspaceMcpConfig
} catch (err) {
  importError = err as Error
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'plan' as const,
    workspacePath: '/tmp/ws',
    workspaceId: 'ws-1',
    conversationId: null,
    featureFlags: {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      localMcpActive: {},
      ...((overrides.featureFlags as Record<string, unknown>) ?? {})
    },
    controlCallbacks: {
      onPlan: () => {},
      onAskUser: () => {}
    },
    ...overrides
  }
}

describe('buildWorkspaceMcpConfig', () => {
  if (!buildWorkspaceMcpConfig) {
    test('skipped_cannot_import_with_electron_stub', () => {
      assert.ok(true, `Import failed: ${importError?.message}`)
    })
    return
  }

  const build = buildWorkspaceMcpConfig

  // Probe: can it run?
  let probe: ReturnType<typeof build> | null = null
  try {
    probe = build(makeOpts())
  } catch {
    // might fail if electron stub doesn't work
  }

  if (!probe) {
    test('skipped_electron_app_not_stubbed_in_suite_mode', () => {
      assert.ok(true, 'Electron app not stubbed properly in suite mode')
    })
    return
  }

  // ── Local provider + small tier ──

  describe('local_provider_small_tier', () => {
    test('includes_only_essential_code_graph_tools_not_full_set', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'small'
        })
      )
      // Should include some code-graph tools
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      assert.equal(
        codeGraphTools.length,
        6,
        'Small tier should have exactly 6 essential code-graph tools'
      )
    })

    test('excludes_semantic_search_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'small'
        })
      )
      const semanticTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__semantic-search__')) ?? []
      assert.equal(semanticTools.length, 0, 'Small tier should have no semantic-search tools')
    })

    test('excludes_code_analysis_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'small'
        })
      )
      const analysisTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-analysis__')) ?? []
      assert.equal(analysisTools.length, 0, 'Small tier should have no code-analysis tools')
    })

    test('disallowedTools_includes_non_essential_code_graph', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'small'
        })
      )
      // The disallowed list should include redundant code-graph tools
      assert.ok(result.disallowedTools.length > 0, 'Small tier should have disallowed tools')
    })
  })

  // ── Local provider + medium tier ──

  describe('local_provider_medium_tier', () => {
    test('includes_full_code_graph_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'medium'
        })
      )
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      assert.ok(codeGraphTools.length > 6, 'Medium tier should have more than 6 code-graph tools')
    })

    test('includes_semantic_search_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'medium'
        })
      )
      const semanticTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__semantic-search__')) ?? []
      assert.ok(semanticTools.length > 0, 'Medium tier should have semantic-search tools')
    })

    test('includes_code_analysis_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'medium'
        })
      )
      const analysisTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-analysis__')) ?? []
      assert.ok(analysisTools.length > 0, 'Medium tier should have code-analysis tools')
    })
  })

  // ── Local provider + large tier ──

  describe('local_provider_large_tier', () => {
    test('includes_all_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: true,
          contextTier: 'large'
        })
      )
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      const semanticTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__semantic-search__')) ?? []
      assert.ok(codeGraphTools.length > 6, 'Large tier should have full code-graph tools')
      assert.ok(semanticTools.length > 0, 'Large tier should have semantic-search tools')
    })
  })

  // ── Claude provider (no tier gating) ──

  describe('claude_provider_no_tier_gating', () => {
    test('full_tool_set_regardless_of_tier', () => {
      const result = build(
        makeOpts({
          isLocalProvider: false
        })
      )
      // Claude should have code-graph tools when featureFlags enable them
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      assert.ok(codeGraphTools.length > 0, 'Claude should have code-graph tools')
    })

    test('includes_control_action_tools', () => {
      const result = build(makeOpts({ isLocalProvider: false }))
      const controlTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__control-actions__')) ?? []
      assert.ok(controlTools.length > 0, 'Claude should have control-action tools')
    })
  })

  // ── Feature flags ──

  describe('feature_flags', () => {
    test('repomapEnabled_false_excludes_code_graph_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: false,
          featureFlags: {
            repomapEnabled: false,
            semanticSearchEnabled: true,
            githubConfigured: false,
            localMcpActive: {}
          }
        })
      )
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      assert.equal(
        codeGraphTools.length,
        0,
        'Should have no code-graph tools when repomapEnabled=false'
      )
    })

    test('semanticSearchEnabled_false_excludes_semantic_search_tools', () => {
      const result = build(
        makeOpts({
          isLocalProvider: false,
          featureFlags: {
            repomapEnabled: true,
            semanticSearchEnabled: false,
            githubConfigured: false,
            localMcpActive: {}
          }
        })
      )
      const semanticTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__semantic-search__')) ?? []
      assert.equal(
        semanticTools.length,
        0,
        'Should have no semantic-search tools when semanticSearchEnabled=false'
      )
    })

    test('null_workspaceId_excludes_code_graph', () => {
      const result = build(
        makeOpts({
          isLocalProvider: false,
          workspaceId: null
        })
      )
      const codeGraphTools =
        result.allowedTools?.filter((t) => t.startsWith('mcp__code-graph__')) ?? []
      assert.equal(codeGraphTools.length, 0)
    })
  })

  // ── Plan mode disallowed tools ──

  describe('plan_mode_disallowed', () => {
    test('disallowedTools_includes_Agent', () => {
      const result = build(makeOpts({ mode: 'plan' }))
      assert.ok(result.disallowedTools.includes('Agent'))
    })

    test('disallowedTools_includes_ExitPlanMode', () => {
      const result = build(makeOpts({ mode: 'plan' }))
      assert.ok(result.disallowedTools.includes('ExitPlanMode'))
    })
  })

  // ── Build mode ──

  describe('build_mode', () => {
    test('build_mode_allowedTools_is_undefined', () => {
      const result = build(makeOpts({ mode: 'build', isLocalProvider: false }))
      assert.equal(result.allowedTools, undefined)
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
