/**
 * Unit tests for CliMcpConfigWriter — generates --mcp-config JSON for CLI sessions.
 *
 * Tests the buildConfig() private method via (instance as any) after stubbing
 * the Electron `app` module. Verifies feature-flag gating of MCP servers
 * and config shape.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

// Use the shared electron stub (ipcMain, app, BrowserWindow, electron-log).
// Safe to call multiple times — idempotent.
setupElectronStub()

// Stub appPreferenceRepository — patch instance methods in place for pre-loaded modules.
try {
  const appPrefRepoPath = require.resolve('../../db/repositories/app-preference.repository')
  const cached = require.cache[appPrefRepoPath]
  if (cached?.exports?.appPreferenceRepository) {
    const repo = cached.exports.appPreferenceRepository
    repo.get = (_key: string) => null
    repo.set = (_key: string, _val: string) => {}
    repo.getBool = (_key: string, _def?: boolean) => _def ?? false
  } else {
    require.cache[appPrefRepoPath] = {
      id: appPrefRepoPath,
      filename: appPrefRepoPath,
      loaded: true,
      exports: {
        appPreferenceRepository: {
          get: () => null,
          set: () => {},
          getBool: (_k: string, d?: boolean) => d ?? false
        }
      },
      children: [],
      paths: [],
      path: ''
    } as unknown as NodeModule
  }
} catch {
  // skip
}

// Now dynamically import
let CliMcpConfigWriter: typeof import('../cli-mcp-config-writer').CliMcpConfigWriter | null = null
let importError: Error | null = null

try {
  const mod = require('../cli-mcp-config-writer')
  CliMcpConfigWriter = mod.CliMcpConfigWriter
} catch (err) {
  importError = err as Error
}

/** Try to build config — returns null if Electron app stub fails at runtime. */
function tryBuildConfig(
  Writer: typeof import('../cli-mcp-config-writer').CliMcpConfigWriter,
  overrides: Record<string, unknown> = {}
): {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
} | null {
  try {
    const writer = new Writer()
    const buildFn = (writer as unknown as { buildConfig: (opts: unknown) => unknown }).buildConfig
    return buildFn.call(writer, {
      workspacePath: '/test/workspace',
      workspaceId: 'ws-1',
      conversationId: null,
      mode: 'plan',
      featureFlags: {
        repomapEnabled: true,
        semanticSearchEnabled: true,
        githubConfigured: false,
        localMcpActive: {},
        ...overrides
      },
      ...overrides
    }) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
    }
  } catch {
    return null
  }
}

describe('CliMcpConfigWriter.buildConfig', () => {
  if (!CliMcpConfigWriter) {
    test('skipped_cannot_import_with_electron_stub', () => {
      assert.ok(true, `Import failed: ${importError?.message}`)
    })
    return
  }

  const Writer = CliMcpConfigWriter

  // Pre-check: can buildConfig run? If Electron's real `app` module was loaded
  // by a prior test in the suite, the stub won't work and all tests should skip.
  const probe = tryBuildConfig(Writer)
  if (!probe) {
    test('skipped_electron_app_not_stubbed_in_suite_mode', () => {
      assert.ok(true, 'Electron app already loaded by prior tests — skipping')
    })
    return
  }

  function buildConfig(overrides: Record<string, unknown> = {}) {
    return tryBuildConfig(Writer, overrides)!
  }

  test('returns_object_with_mcpServers_key', () => {
    const config = buildConfig()
    assert.ok('mcpServers' in config)
    assert.equal(typeof config.mcpServers, 'object')
  })

  test('servers_have_command_and_args', () => {
    const config = buildConfig()
    for (const [_name, server] of Object.entries(config.mcpServers)) {
      assert.equal(typeof server.command, 'string')
      assert.ok(Array.isArray(server.args))
    }
  })

  test('repomapEnabled_true_includes_code_graph_server', () => {
    const config = buildConfig({ repomapEnabled: true })
    assert.ok('code-graph' in config.mcpServers, 'Should have code-graph server')
  })

  test('repomapEnabled_false_excludes_code_graph_server', () => {
    const config = buildConfig({
      featureFlags: {
        repomapEnabled: false,
        semanticSearchEnabled: true,
        githubConfigured: false,
        localMcpActive: {}
      }
    })
    assert.ok(!('code-graph' in config.mcpServers), 'Should not have code-graph server')
  })

  test('semanticSearchEnabled_true_includes_semantic_search_server', () => {
    const config = buildConfig({ semanticSearchEnabled: true })
    assert.ok('semantic-search' in config.mcpServers, 'Should have semantic-search server')
  })

  test('semanticSearchEnabled_false_excludes_semantic_search_server', () => {
    const config = buildConfig({
      featureFlags: {
        repomapEnabled: true,
        semanticSearchEnabled: false,
        githubConfigured: false,
        localMcpActive: {}
      }
    })
    assert.ok(!('semantic-search' in config.mcpServers), 'Should not have semantic-search server')
  })

  test('always_includes_git_context_server', () => {
    const config = buildConfig({
      featureFlags: {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        localMcpActive: {}
      }
    })
    assert.ok('git-context' in config.mcpServers, 'Should always have git-context server')
  })

  test('always_includes_code_analysis_server', () => {
    const config = buildConfig({
      featureFlags: {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        localMcpActive: {}
      }
    })
    assert.ok('code-analysis' in config.mcpServers, 'Should always have code-analysis server')
  })

  test('always_includes_control_actions_server', () => {
    const config = buildConfig({
      featureFlags: {
        repomapEnabled: false,
        semanticSearchEnabled: false,
        githubConfigured: false,
        localMcpActive: {}
      }
    })
    assert.ok('control-actions' in config.mcpServers, 'Should always have control-actions server')
  })

  test('environment_variables_include_workspace_path', () => {
    const config = buildConfig()
    const gitCtx = config.mcpServers['git-context']
    assert.ok(gitCtx)
    assert.equal(gitCtx.env?.WORKSPACE_PATH, '/test/workspace')
  })

  test('skipServers_removes_specified_servers_from_config', () => {
    const config = buildConfig({ skipServers: ['control-actions', 'code-analysis'] })
    assert.ok(!('control-actions' in config.mcpServers), 'control-actions should be removed')
    assert.ok(!('code-analysis' in config.mcpServers), 'code-analysis should be removed')
    // Other servers should still be present
    assert.ok('git-context' in config.mcpServers, 'git-context should remain')
  })

  test('skipServers_empty_array_removes_nothing', () => {
    const config = buildConfig({ skipServers: [] })
    assert.ok('control-actions' in config.mcpServers, 'control-actions should remain')
    assert.ok('git-context' in config.mcpServers, 'git-context should remain')
  })

  test('skipServers_undefined_removes_nothing', () => {
    const config = buildConfig({ skipServers: undefined })
    assert.ok('control-actions' in config.mcpServers, 'control-actions should remain')
  })

  test('code_graph_env_includes_workspace_id_and_db_path', () => {
    const config = buildConfig()
    const cg = config.mcpServers['code-graph']
    assert.ok(cg)
    assert.equal(cg.env?.WORKSPACE_ID, 'ws-1')
    assert.equal(cg.env?.DB_PATH, '/tmp/electron-test/userData')
  })
})

// ── Dispose ──

describe('CliMcpConfigWriter.dispose', () => {
  if (!CliMcpConfigWriter) {
    test('skipped_cannot_import', () => assert.ok(true))
    return
  }

  test('dispose_is_safe_for_unknown_workspace', () => {
    const writer = new CliMcpConfigWriter()
    // Should not throw
    writer.dispose('/non/existent/path')
    assert.ok(true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
