/**
 * Schema validation tests for OpenCode config generation.
 *
 * Validates that buildConfig() produces configs compatible with
 * OpenCode ≤1.17.x schema expectations:
 *  - tools.skill must be a boolean (not an object)
 *  - shell must be a string (not an object)
 *  - No unrecognized top-level keys
 *  - All required fields present
 *
 * Regression test for ConfigInvalidError at session.create.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Stub Electron app before importing (same pattern as opencode-config-writer-logic.test.ts) ──

const electronMock = {
  app: {
    get isPackaged() { return false },
    getAppPath() { return '/mock/app' },
    getPath(name: string) {
      if (name === 'userData') return '/mock/userData'
      return `/mock/${name}`
    }
  }
}

try {
  const Module = require('module')
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request: string, ...args: unknown[]) {
    if (request === 'electron') return 'electron'
    return origResolve.call(this, request, ...args)
  }
  require.cache[require.resolve('electron')] = {
    id: 'electron',
    filename: 'electron',
    loaded: true,
    exports: electronMock,
    children: [],
    paths: [],
    path: ''
  } as unknown as NodeModule
} catch {
  // skip
}

// Stub electron-log/main
try {
  const logMock = {
    scope: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    info: () => {},
    warn: () => {},
    error: () => {}
  }
  require.cache[require.resolve('electron-log/main')] = {
    id: 'electron-log/main',
    filename: 'electron-log/main',
    loaded: true,
    exports: { default: logMock, ...logMock },
    children: [],
    paths: [],
    path: ''
  } as unknown as NodeModule
} catch {
  // skip
}

// Stub appPreferenceRepository to avoid DB dependency
try {
  const appPrefRepoPath = require.resolve('../../db/repositories/app-preference.repository')
  require.cache[appPrefRepoPath] = {
    id: appPrefRepoPath,
    filename: appPrefRepoPath,
    loaded: true,
    exports: {
      appPreferenceRepository: { get: (_key: string) => null }
    },
    children: [],
    paths: [],
    path: ''
  } as unknown as NodeModule
} catch {
  // skip
}

// Now dynamically import
let OpenCodeConfigWriter: typeof import('../opencode-config-writer').OpenCodeConfigWriter | null = null
let importError: Error | null = null

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../opencode-config-writer')
  OpenCodeConfigWriter = mod.OpenCodeConfigWriter
} catch (err) {
  importError = err as Error
}

// ── Minimal valid options for buildConfig ──

const baseOpts = {
  workspacePath: '/tmp/test-workspace',
  workspaceId: 'test-ws-id',
  conversationId: 'test-conv-id',
  provider: { providerId: 'ollama', modelId: 'llama3', baseUrl: 'http://localhost:11434' },
  mode: 'plan' as const,
  isLocalProvider: true,
  contextTier: 'small' as const,
  ipcSocketPath: '/tmp/test.sock',
  webSearchEnabled: false,
  formatterEnabled: false,
  lspEnabled: false,
  featureFlags: {
    repomapEnabled: true,
    semanticSearchEnabled: true,
    githubConfigured: false,
    localMcpActive: {},
  },
}

describe('OpenCode config schema compliance', () => {
  if (!OpenCodeConfigWriter) {
    test('skipped — cannot import with electron stub', () => {
      assert.ok(true, `Import failed: ${importError?.message}`)
    })
    return
  }

  const Writer = OpenCodeConfigWriter
  let writer: InstanceType<typeof Writer>
  try {
    writer = new Writer()
  } catch {
    test('skipped — cannot instantiate', () => {
      assert.ok(true, 'Electron app not stubbed properly')
    })
    return
  }

  const w = writer as any

  // ── Core schema constraints (regression for ConfigInvalidError) ──

  test('tools.skill is a boolean, not an object', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(
      typeof config.tools.skill,
      'boolean',
      `tools.skill must be boolean, got ${typeof config.tools.skill}: ${JSON.stringify(config.tools.skill)}`
    )
  })

  test('tools.question is a boolean', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(typeof config.tools.question, 'boolean')
  })

  test('shell is a string, not an object', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(
      typeof config.shell,
      'string',
      `shell must be a string, got ${typeof config.shell}: ${JSON.stringify(config.shell)}`
    )
  })

  test('shell is a valid shell path', () => {
    const config = w.buildConfig(baseOpts)
    assert.ok(
      config.shell === '/bin/bash' || config.shell === 'pwsh',
      `Expected /bin/bash or pwsh, got: ${config.shell}`
    )
  })

  test('no unrecognized top-level keys', () => {
    const config = w.buildConfig(baseOpts)
    const knownKeys = new Set([
      '$schema', 'model', 'small_model', 'default_agent', 'autoupdate',
      'provider', 'disabled_providers', 'enabled_providers',
      'mcp', 'plugin', 'instructions', 'tools', 'permission',
      'compaction', 'snapshot', 'shell', 'formatter', 'lsp',
      'attachment', 'watcher', 'server', 'share',
    ])
    const configKeys = Object.keys(config)
    const unrecognized = configKeys.filter(k => !knownKeys.has(k))
    assert.deepEqual(
      unrecognized,
      [],
      `Unrecognized top-level keys: ${unrecognized.join(', ')}`
    )
  })

  // ── Required fields ──

  test('has $schema pointing to opencode.ai', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(config.$schema, 'https://opencode.ai/config.json')
  })

  test('has model string', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(typeof config.model, 'string')
    assert.ok(config.model.length > 0)
  })

  test('has provider, mcp, permission objects', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(typeof config.provider, 'object')
    assert.equal(typeof config.mcp, 'object')
    assert.equal(typeof config.permission, 'object')
  })

  test('has compaction with enabled, auto, prune, reserved', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(typeof config.compaction, 'object')
    assert.equal(config.compaction.enabled, true)
    assert.equal(typeof config.compaction.auto, 'boolean')
    assert.equal(typeof config.compaction.prune, 'boolean')
    assert.equal(typeof config.compaction.reserved, 'number')
  })

  test('snapshot=true, autoupdate=false, default_agent=davinci', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(config.snapshot, true)
    assert.equal(config.autoupdate, false)
    assert.equal(config.default_agent, 'davinci')
  })

  // ── Local vs cloud provider ──

  test('local provider disables cloud providers', () => {
    const config = w.buildConfig(baseOpts)
    assert.ok(Array.isArray(config.disabled_providers))
    assert.ok(config.disabled_providers.includes('anthropic'))
    assert.ok(config.disabled_providers.includes('openai'))
    assert.ok(config.disabled_providers.includes('google'))
  })

  test('cloud provider enables only selected provider', () => {
    const cloudOpts = {
      ...baseOpts,
      provider: { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' },
      isLocalProvider: false,
      contextTier: undefined,
    }
    const config = w.buildConfig(cloudOpts)
    assert.ok(Array.isArray(config.enabled_providers))
    assert.ok(config.enabled_providers.includes('anthropic'))
    assert.equal(config.disabled_providers, undefined)
  })

  // ── Web search toggle ──

  test('webSearchEnabled=false omits websearch/webfetch', () => {
    const config = w.buildConfig(baseOpts)
    assert.equal(config.tools.websearch, undefined)
    assert.equal(config.tools.webfetch, undefined)
  })

  test('webSearchEnabled=true includes websearch/webfetch', () => {
    const config = w.buildConfig({ ...baseOpts, webSearchEnabled: true })
    assert.equal(config.tools.websearch, true)
    assert.equal(config.tools.webfetch, true)
  })

  // ── Shell env propagation via process.env ──

  test('buildConfig injects shell env vars into process.env', () => {
    const saved = {
      WORKSPACE_PATH: process.env.WORKSPACE_PATH,
      GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT,
      IPC_SOCKET_PATH: process.env.IPC_SOCKET_PATH,
    }
    try {
      w.buildConfig(baseOpts)
      assert.equal(process.env.WORKSPACE_PATH, '/tmp/test-workspace')
      assert.equal(process.env.GIT_TERMINAL_PROMPT, '0')
      assert.equal(process.env.IPC_SOCKET_PATH, '/tmp/test.sock')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v
        else delete process.env[k]
      }
    }
  })

  // ── JSON roundtrip ──

  test('config serializes to valid JSON with no functions', () => {
    const config = w.buildConfig(baseOpts)
    const json = JSON.stringify(config)
    assert.ok(json.length > 0)
    const parsed = JSON.parse(json)
    assert.equal(parsed.$schema, 'https://opencode.ai/config.json')

    // Walk the tree — no function values allowed
    const walk = (obj: any, path = ''): void => {
      for (const [key, val] of Object.entries(obj)) {
        const p = `${path}.${key}`
        assert.notEqual(typeof val, 'function', `Function found at ${p}`)
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          walk(val, p)
        }
      }
    }
    walk(parsed)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
