/**
 * Unit tests for opencode-config-data.ts — registry-based MCP server builder.
 *
 * Phase 6A Coverage Improvement — lines 109-138, 176 (currently 73.8% → 80%+).
 * Covers: buildLocalMcpServersFromRegistry, DB_BACKED_SERVER_IDS, FORMATTER_DEFS.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildLocalMcpServersFromRegistry,
  DB_BACKED_SERVER_IDS,
  FORMATTER_DEFS,
  type LocalMcpServerDef
} from '../opencode-config-writer/opencode-config-data'

// ── Helpers ──

function makeDef(overrides: Partial<LocalMcpServerDef> = {}): LocalMcpServerDef {
  return {
    id: 'test-server',
    serverScript: 'test-server.js',
    condition: () => true,
    environment: () => ({}),
    timeout: 5000,
    ...overrides
  }
}

const minimalOpts = {
  workspacePath: '/workspace',
  workspaceId: 'ws-1',
  conversationId: 'conv-1',
  mode: 'build' as const,
  provider: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
  featureFlags: {
    repomapEnabled: false,
    semanticSearchEnabled: false,
    githubConfigured: false,
    localMcpActive: {}
  },
  ipcSocketPath: '/tmp/ipc.sock'
}

// ── buildLocalMcpServersFromRegistry ──

describe('buildLocalMcpServersFromRegistry', () => {
  test('condition false → server excluded', () => {
    const defs = [makeDef({ condition: () => false })]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.equal(Object.keys(result).length, 0)
  })

  test('condition true → server included with correct shape', () => {
    const defs = [makeDef({ id: 'my-server', serverScript: 'my-server.js', timeout: 7000 })]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.ok(result['my-server'])
    assert.equal(result['my-server'].type, 'local')
    assert.deepEqual(result['my-server'].command, ['node', '/servers/my-server.js'])
    assert.equal(result['my-server'].timeout, 7000)
  })

  test('server with non-empty environment → environment included', () => {
    const defs = [
      makeDef({
        environment: (opts: any) => ({ WORKSPACE_PATH: opts.workspacePath })
      })
    ]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.ok(result['test-server'].environment)
    assert.equal(result['test-server'].environment!.WORKSPACE_PATH, '/workspace')
  })

  test('server with empty environment → environment omitted', () => {
    const defs = [makeDef({ environment: () => ({}) })]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.equal(result['test-server'].environment, undefined, 'empty env should be omitted')
  })

  test('DB-backed server (code-graph) with dbDir → DB_PATH injected', () => {
    const defs = [
      makeDef({
        id: 'code-graph',
        environment: () => ({ WORKSPACE_ID: 'ws-1' })
      })
    ]
    const result = buildLocalMcpServersFromRegistry(
      defs,
      minimalOpts as any,
      '/servers',
      '/path/to/db'
    )
    assert.equal(result['code-graph'].environment!.DB_PATH, '/path/to/db')
    assert.equal(result['code-graph'].environment!.WORKSPACE_ID, 'ws-1')
  })

  test('DB-backed server (semantic-search) with dbDir → DB_PATH injected', () => {
    const defs = [
      makeDef({
        id: 'semantic-search',
        environment: () => ({})
      })
    ]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers', '/db/dir')
    assert.equal(result['semantic-search'].environment!.DB_PATH, '/db/dir')
  })

  test('DB-backed server without dbDir → no DB_PATH', () => {
    const defs = [
      makeDef({
        id: 'code-graph',
        environment: () => ({ WORKSPACE_ID: 'ws-1' })
      })
    ]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.equal(result['code-graph'].environment!.DB_PATH, undefined)
  })

  test('non-DB-backed server → never gets DB_PATH', () => {
    const defs = [
      makeDef({
        id: 'git-context',
        environment: () => ({ FOO: 'bar' })
      })
    ]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers', '/db/dir')
    assert.equal(result['git-context'].environment!.DB_PATH, undefined)
  })

  test('multiple defs → mixed condition results', () => {
    const defs = [
      makeDef({ id: 'active-1', condition: () => true }),
      makeDef({ id: 'inactive', condition: () => false }),
      makeDef({ id: 'active-2', condition: () => true })
    ]
    const result = buildLocalMcpServersFromRegistry(defs, minimalOpts as any, '/servers')
    assert.ok(result['active-1'])
    assert.ok(!result['inactive'])
    assert.ok(result['active-2'])
    assert.equal(Object.keys(result).length, 2)
  })
})

// ── DB_BACKED_SERVER_IDS ──

describe('DB_BACKED_SERVER_IDS', () => {
  test('contains code-graph and semantic-search', () => {
    assert.ok(DB_BACKED_SERVER_IDS.has('code-graph'))
    assert.ok(DB_BACKED_SERVER_IDS.has('semantic-search'))
  })

  test('does not contain other servers', () => {
    assert.ok(!DB_BACKED_SERVER_IDS.has('git-context'))
    assert.ok(!DB_BACKED_SERVER_IDS.has('control-actions'))
  })
})

// ── FORMATTER_DEFS ──

describe('FORMATTER_DEFS', () => {
  test('contains 3 formatters', () => {
    assert.equal(FORMATTER_DEFS.length, 3)
  })

  test('prettier entry has correct config files', () => {
    const prettier = FORMATTER_DEFS[0]
    assert.ok(prettier.configFiles.includes('.prettierrc'))
    assert.ok(prettier.configFiles.includes('.prettierrc.json'))
    assert.deepEqual(prettier.command, ['npx', 'prettier', '--write'])
  })

  test('biome entry has correct config files', () => {
    const biome = FORMATTER_DEFS[1]
    assert.ok(biome.configFiles.includes('biome.json'))
    assert.ok(biome.configFiles.includes('biome.jsonc'))
  })

  test('dprint entry has correct config files and extensions', () => {
    const dprint = FORMATTER_DEFS[2]
    assert.ok(dprint.configFiles.includes('dprint.json'))
    assert.ok(dprint.configFiles.includes('.dprint.json'))
    assert.deepEqual(dprint.command, ['npx', 'dprint', 'fmt'])
    assert.ok(dprint.extensions.includes('.ts'))
    assert.ok(dprint.extensions.includes('.md'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
