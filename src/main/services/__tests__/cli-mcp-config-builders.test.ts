/**
 * Unit tests for cli-mcp-config-builders.ts — pure server-selection logic.
 *
 * Covers: buildCoreServers, applyLocalMcpToggles, buildTempDirName.
 * mountExternalIntegrations tested with mock integrations (EXTERNAL_MCP_INTEGRATIONS).
 *
 * Phase 4B — ~15 tests. All pure logic, no Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildCoreServers,
  applyLocalMcpToggles,
  buildTempDirName,
  mountExternalIntegrations,
  type BuildCoreServersParams,
  type CliMcpServerEntry
} from '../cli-mcp-config-builders'

// ── Fixtures ──

function makeParams(overrides: Partial<BuildCoreServersParams> = {}): BuildCoreServersParams {
  return {
    featureFlags: {
      repomapEnabled: true,
      semanticSearchEnabled: true,
      githubConfigured: false,
      localMcpActive: {},
      ...overrides.featureFlags
    },
    workspaceId: 'ws-001',
    workspacePath: '/home/user/project',
    conversationId: null,
    mode: 'build',
    serverBasePath: '/app/mcp-servers',
    dbDir: '/app/data',
    ...overrides
  }
}

// ── buildCoreServers ──

describe('buildCoreServers', () => {
  test('repomapEnabled → code-graph server included', () => {
    const servers = buildCoreServers(makeParams())
    assert.ok(servers['code-graph'], 'code-graph should be present')
    assert.ok(servers['code-graph'].args[0].includes('code-graph-server.js'))
    assert.equal(servers['code-graph'].env?.WORKSPACE_ID, 'ws-001')
    assert.equal(servers['code-graph'].env?.DB_PATH, '/app/data')
  })

  test('F2: every server spawns via execPath with ELECTRON_RUN_AS_NODE=1', () => {
    const servers = buildCoreServers(makeParams())
    for (const [id, entry] of Object.entries(servers)) {
      assert.equal(
        entry.command,
        process.execPath,
        `${id} must spawn the app binary, not a PATH 'node'`
      )
      assert.equal(entry.env?.ELECTRON_RUN_AS_NODE, '1', `${id} must set ELECTRON_RUN_AS_NODE`)
    }
  })

  test('repomapEnabled=false → no code-graph server', () => {
    const servers = buildCoreServers(
      makeParams({
        featureFlags: {
          repomapEnabled: false,
          semanticSearchEnabled: false,
          githubConfigured: false,
          localMcpActive: {}
        }
      })
    )
    assert.equal(servers['code-graph'], undefined)
  })

  test('semanticSearchEnabled → semantic-search server included', () => {
    const servers = buildCoreServers(makeParams())
    assert.ok(servers['semantic-search'])
    assert.ok(servers['semantic-search'].args[0].includes('semantic-search-server.js'))
  })

  test('semanticSearchEnabled=false → no semantic-search server', () => {
    const servers = buildCoreServers(
      makeParams({
        featureFlags: {
          repomapEnabled: true,
          semanticSearchEnabled: false,
          githubConfigured: false,
          localMcpActive: {}
        }
      })
    )
    assert.equal(servers['semantic-search'], undefined)
  })

  test('always-on servers: git-context, code-analysis, control-actions', () => {
    const servers = buildCoreServers(
      makeParams({
        featureFlags: {
          repomapEnabled: false,
          semanticSearchEnabled: false,
          githubConfigured: false,
          localMcpActive: {}
        }
      })
    )
    assert.ok(servers['git-context'], 'git-context always present')
    assert.ok(servers['code-analysis'], 'code-analysis always present')
    assert.ok(servers['control-actions'], 'control-actions always present')
  })

  test('control-actions env contains ipcSocketPath and conversationId when provided', () => {
    const servers = buildCoreServers(
      makeParams({ ipcSocketPath: '/tmp/ipc.sock', conversationId: 'conv-456' })
    )
    const env = servers['control-actions'].env!
    assert.equal(env.IPC_SOCKET_PATH, '/tmp/ipc.sock')
    assert.equal(env.CONVERSATION_ID, 'conv-456')
    assert.equal(env.CONVERSATION_MODE, 'build')
  })

  test('no workspaceId → code-graph and semantic-search excluded', () => {
    const servers = buildCoreServers(makeParams({ workspaceId: null }))
    assert.equal(servers['code-graph'], undefined)
    assert.equal(servers['semantic-search'], undefined)
  })
})

// ── applyLocalMcpToggles ──

describe('applyLocalMcpToggles', () => {
  test('toggle off → server deleted', () => {
    const servers: Record<string, CliMcpServerEntry> = {
      'code-graph': { command: 'node', args: [] },
      'git-context': { command: 'node', args: [] }
    }
    applyLocalMcpToggles(servers, { 'code-graph': false })
    assert.equal(servers['code-graph'], undefined, 'should be deleted')
    assert.ok(servers['git-context'], 'unaffected server should remain')
  })

  test('toggle on → server remains', () => {
    const servers: Record<string, CliMcpServerEntry> = {
      'code-graph': { command: 'node', args: [] }
    }
    applyLocalMcpToggles(servers, { 'code-graph': true })
    assert.ok(servers['code-graph'], 'explicitly enabled server should remain')
  })

  test('missing toggle → server remains (backward-compat)', () => {
    const servers: Record<string, CliMcpServerEntry> = {
      'code-graph': { command: 'node', args: [] }
    }
    applyLocalMcpToggles(servers, {})
    assert.ok(servers['code-graph'], 'server without toggle should remain')
  })

  test('toggle for nonexistent server → no error', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    assert.doesNotThrow(() => {
      applyLocalMcpToggles(servers, { nonexistent: false })
    })
  })
})

// ── buildTempDirName ──

describe('buildTempDirName', () => {
  test('deterministic for same input', () => {
    const a = buildTempDirName('/home/user/project')
    const b = buildTempDirName('/home/user/project')
    assert.equal(a, b)
  })

  test('different input → different output', () => {
    const a = buildTempDirName('/home/user/project-a')
    const b = buildTempDirName('/home/user/project-b')
    assert.notEqual(a, b)
  })

  test('base64url format — max 32 chars, no padding', () => {
    const result = buildTempDirName('/a/very/long/path/that/exceeds/32/chars/easily')
    assert.ok(result.length <= 32, `length should be ≤32, got ${result.length}`)
    // base64url uses only [A-Za-z0-9_-]
    assert.ok(/^[A-Za-z0-9_-]+$/.test(result), 'should be valid base64url')
  })
})

// ── mountExternalIntegrations ──

describe('mountExternalIntegrations', () => {
  const BASE = '/opt/app/out/main/mcp-servers'

  test('inactive integration → not added to servers', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, { maestro: false }, { maestro: {} }, '/home/test', BASE)
    assert.equal(servers['maestro'], undefined)
  })

  test('missing integration ID in externalActive → skipped', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, {}, {}, '/home/test', BASE)
    assert.equal(Object.keys(servers).length, 0)
  })

  test('active but absent from envByIntegration → skipped (incomplete credentials)', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, { maestro: true }, {}, '/nonexistent', BASE)
    assert.equal(servers['maestro'], undefined, 'must not mount without a resolved env')
  })

  test('active integration → server entry created with default command', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    // With a non-existent home path, commandPaths won't resolve → default command used
    mountExternalIntegrations(
      servers,
      { maestro: true },
      { maestro: {} },
      '/nonexistent/home',
      BASE
    )
    assert.ok(servers['maestro'], 'maestro server should be present')
    assert.equal(servers['maestro'].command, 'maestro')
    assert.deepEqual(servers['maestro'].args, ['mcp'])
  })

  test('pre-resolved env is passed through verbatim', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    const env = { JAVA_HOME: '/usr/lib/jvm/java-17', MAESTRO_WAIT_TIMEOUT: '0' }
    mountExternalIntegrations(servers, { maestro: true }, { maestro: env }, '/nonexistent', BASE)
    assert.deepEqual(servers['maestro'].env, env)
  })

  test('empty resolved env → env property omitted for non-bundled', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, { maestro: true }, { maestro: {} }, '/nonexistent', BASE)
    assert.equal(servers['maestro'].env, undefined)
  })

  test('bundledServerEntry → mounted as execPath <basePath>/<entry>.js with ELECTRON_RUN_AS_NODE', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(
      servers,
      { jira: true },
      { jira: { JIRA_BASE_URL: 'https://x.atlassian.net' } },
      '/nonexistent',
      BASE
    )
    // F2: bundled servers run via the app binary (Electron-as-Node), never a
    // PATH `node` — end-user machines frequently have no Node installed.
    assert.equal(servers['jira'].command, process.execPath)
    assert.deepEqual(servers['jira'].args, [`${BASE}/jira-server.js`])
    assert.equal(servers['jira'].env?.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(servers['jira'].env?.JIRA_BASE_URL, 'https://x.atlassian.net')
  })

  test('commandPaths resolution → uses first existing path', () => {
    // Create a temp directory structure to simulate maestro install path
    const tempHome = mkdtempSync(join(tmpdir(), 'cli-mcp-test-'))
    const maestroBinDir = join(tempHome, '.maestro', 'bin')
    mkdirSync(maestroBinDir, { recursive: true })
    const maestroPath = join(maestroBinDir, 'maestro')
    writeFileSync(maestroPath, '#!/bin/bash', { mode: 0o755 })

    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, { maestro: true }, { maestro: {} }, tempHome, BASE)
    assert.equal(servers['maestro'].command, maestroPath, 'should resolve to found path')
  })

  test('args are spread-copied (not shared reference)', () => {
    const servers: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers, { maestro: true }, { maestro: {} }, '/nonexistent', BASE)
    // Mutating the result should not affect the source
    servers['maestro'].args.push('extra')
    const servers2: Record<string, CliMcpServerEntry> = {}
    mountExternalIntegrations(servers2, { maestro: true }, { maestro: {} }, '/nonexistent', BASE)
    assert.deepEqual(servers2['maestro'].args, ['mcp'], 'args should be a fresh copy')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
