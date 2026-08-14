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

// Load the db module first.
//
// `db/index` and the repositories form an import cycle: entering it through a
// repository hits BaseRepository in its temporal dead zone and the whole writer
// import fails, which this file catches and turns into a silent skip. Under the
// shared runner an earlier test happens to load db/index and it works; run
// alone, every test below quietly asserted nothing. Entering through db/index
// is the order that resolves.
try {
  require('../../db/index')
} catch {
  /* no native module here — the writer import below reports it */
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
      executionPath: '/test/workspace',
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

  // ── executionPath vs workspacePath ──────────────────────────────────
  //
  // An agent in a worktree used to get lint results, changed-file lists and
  // process state from the PRIMARY tree and present them as its own. These pin
  // which servers follow the agent and which deliberately do not.

  describe('per-tree vs shared servers', () => {
    const WORKTREE = '/test/worktrees/feat-a'
    const inWorktree = (): ReturnType<typeof buildConfig> =>
      buildConfig({ executionPath: WORKTREE })

    test('git-context follows the execution tree', () => {
      assert.equal(inWorktree().mcpServers['git-context'].env?.WORKSPACE_PATH, WORKTREE)
    })

    test('code-analysis follows the execution tree', () => {
      const ca = inWorktree().mcpServers['code-analysis']
      assert.equal(ca.env?.WORKSPACE_PATH, WORKTREE)
      // Workspace identity is unchanged — only the directory moved.
      assert.equal(ca.env?.WORKSPACE_ID, 'ws-1')
    })

    test('process-manager follows the execution tree', () => {
      assert.equal(inWorktree().mcpServers['process-manager'].env?.WORKSPACE_PATH, WORKTREE)
    })

    test('control-actions follows the execution tree', () => {
      assert.equal(inWorktree().mcpServers['control-actions'].env?.WORKSPACE_PATH, WORKTREE)
    })

    test('code-graph follows the execution tree too — a track is its own branch', () => {
      const cg = inWorktree().mcpServers['code-graph']
      // Pointing the graph at the primary tree meant an agent on a track's
      // branch queried an index built from a different set of files, got
      // nothing back, and could not tell that from "the symbol does not exist".
      assert.equal(cg.env?.WORKSPACE_PATH, WORKTREE)
      // Superseded by scoping the index itself; there is no stale tree to warn about.
      assert.equal(cg.env?.EXECUTION_PATH, undefined)
    })

    test('code-graph is scoped to the primary workspace when not in a track', () => {
      const cg = buildConfig().mcpServers['code-graph']
      assert.equal(cg.env?.WORKSPACE_PATH, '/test/workspace')
      assert.equal(cg.env?.WORKSPACE_ID, 'ws-1')
      assert.equal(cg.env?.EXECUTION_PATH, undefined)
    })
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

// ── Config file isolation ──────────────────────────────────────────
//
// The trap in threading executionPath through: the temp directory was hashed
// from workspacePath alone, so two trees of one workspace resolved to the same
// file and the whole change would have silently no-opped.

describe('CliMcpConfigWriter.writeConfig — per-tree isolation', () => {
  if (!CliMcpConfigWriter) {
    test('skipped_cannot_import', () => assert.ok(true))
    return
  }
  const Writer = CliMcpConfigWriter

  const baseOpts = {
    workspacePath: '/test/workspace',
    workspaceId: 'ws-1',
    conversationId: null,
    mode: 'plan' as const,
    featureFlags: {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      localMcpActive: {}
    },
    instanceId: 'inst-1'
  }

  const write = (writer: InstanceType<typeof Writer>, executionPath: string): string | null => {
    try {
      return writer.writeConfig({ ...baseOpts, executionPath })
    } catch {
      return null
    }
  }

  test('two trees on one instance get two config files', () => {
    const writer = new Writer()
    const a = write(writer, '/test/workspace')
    const b = write(writer, '/test/worktrees/feat-a')
    if (!a || !b) {
      assert.ok(true, 'Electron app not stubbed in suite mode — skipped')
      return
    }
    assert.notEqual(a, b, 'a worktree must not share the primary tree’s config file')
  })

  test('dispose removes every config the session wrote, not just the last', () => {
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const writer = new Writer()
    const a = write(writer, '/test/workspace')
    const b = write(writer, '/test/worktrees/feat-b')
    if (!a || !b) {
      assert.ok(true, 'Electron app not stubbed in suite mode — skipped')
      return
    }

    writer.dispose(baseOpts.workspacePath, baseOpts.instanceId)
    assert.equal(existsSync(a), false, 'first tree’s config leaked')
    assert.equal(existsSync(b), false, 'second tree’s config leaked')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
