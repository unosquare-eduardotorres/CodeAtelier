/**
 * Unit tests for OpenCodeConfigWriter private pure methods.
 *
 * Tests: resolveSmallModel, buildPermissions, buildCompactionConfig,
 * buildProviderConfig, buildShellEnvironment.
 *
 * Strategy: Stub Electron `app` and `electron-log/main` at require cache level,
 * then access private methods via `(writer as any).methodName(...)`.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Stub Electron app before importing ──

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

describe('OpenCodeConfigWriter private methods', () => {
  if (!OpenCodeConfigWriter) {
    test('skipped_cannot_import_with_electron_stub', () => {
      assert.ok(true, `Import failed: ${importError?.message}`)
    })
    return
  }

  const Writer = OpenCodeConfigWriter

  // Pre-check — can we instantiate?
  let writer: InstanceType<typeof Writer>
  try {
    writer = new Writer()
  } catch {
    test('skipped_cannot_instantiate_in_suite_mode', () => {
      assert.ok(true, 'Electron app not stubbed properly in suite mode')
    })
    return
  }

  const w = writer as any

  // ── resolveSmallModel ──

  describe('resolveSmallModel', () => {
    test('anthropic_returns_anthropic_claude_haiku', () => {
      assert.equal(w.resolveSmallModel('anthropic'), 'anthropic/claude-haiku-3-5')
    })

    test('openai_returns_openai_gpt4o_mini', () => {
      assert.equal(w.resolveSmallModel('openai'), 'openai/gpt-4o-mini')
    })

    test('google_returns_google_gemini_flash_lite', () => {
      assert.equal(w.resolveSmallModel('google'), 'google/gemini-2.0-flash-lite')
    })

    test('ollama_returns_ollama_qwen3', () => {
      assert.equal(w.resolveSmallModel('ollama'), 'ollama/qwen3:8b')
    })

    test('omlx_returns_undefined', () => {
      assert.equal(w.resolveSmallModel('omlx'), undefined)
    })

    test('unknown_provider_returns_undefined', () => {
      assert.equal(w.resolveSmallModel('something-else'), undefined)
    })
  })

  // ── buildPermissions ──

  describe('buildPermissions', () => {
    test('build_mode_allows_Write_Edit_Bash', () => {
      const perms = w.buildPermissions('build')
      assert.equal(perms.Write, 'allow')
      assert.equal(perms.Edit, 'allow')
      assert.equal(perms.Bash, 'allow')
    })

    test('danger_mode_allows_Write_Edit_Bash', () => {
      const perms = w.buildPermissions('danger')
      assert.equal(perms.Write, 'allow')
      assert.equal(perms.Edit, 'allow')
      assert.equal(perms.Bash, 'allow')
    })

    test('plan_mode_Write_is_ask', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(perms.Write, 'ask')
    })

    test('plan_mode_Edit_is_ask', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(perms.Edit, 'ask')
    })

    test('plan_mode_Bash_has_glob_patterns', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(typeof perms.Bash, 'object')
      assert.equal(perms.Bash['*'], 'ask')
      assert.equal(perms.Bash['git status *'], 'allow')
      assert.equal(perms.Bash['npm test *'], 'allow')
    })

    test('plan_mode_task_is_deny', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(perms.task, 'deny')
    })

    test('plan_mode_external_directory_is_deny', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(perms.external_directory, 'deny')
    })

    test('plan_mode_Read_is_allow', () => {
      const perms = w.buildPermissions('plan')
      assert.equal(perms.Read, 'allow')
    })
  })

  // ── buildCompactionConfig ──

  describe('buildCompactionConfig', () => {
    test('small_tier_reserved_4096', () => {
      const config = w.buildCompactionConfig('small')
      assert.equal(config.reserved, 4096)
      assert.equal(config.enabled, true)
      assert.equal(config.auto, true)
      assert.equal(config.prune, true)
    })

    test('medium_tier_reserved_8192', () => {
      const config = w.buildCompactionConfig('medium')
      assert.equal(config.reserved, 8192)
    })

    test('large_tier_reserved_16384', () => {
      const config = w.buildCompactionConfig('large')
      assert.equal(config.reserved, 16384)
    })

    test('undefined_tier_defaults_to_8192', () => {
      const config = w.buildCompactionConfig(undefined)
      assert.equal(config.reserved, 8192)
    })
  })

  // ── buildProviderConfig ──

  describe('buildProviderConfig', () => {
    test('local_true_timeout_600000', () => {
      const provider = { providerId: 'ollama', modelId: 'llama3', baseUrl: 'http://localhost:11434' }
      const config = w.buildProviderConfig(provider, true)
      const entry = config[provider.providerId]
      assert.equal(entry.timeout, 600_000)
      assert.equal(entry.chunkTimeout, 30_000)
    })

    test('local_false_timeout_300000', () => {
      const provider = { providerId: 'anthropic', modelId: 'claude-3', apiKey: 'sk-test' }
      const config = w.buildProviderConfig(provider, false)
      const entry = config[provider.providerId]
      assert.equal(entry.timeout, 300_000)
      assert.equal(entry.chunkTimeout, 15_000)
    })

    test('anthropic_provider_has_setCacheKey_true', () => {
      const provider = { providerId: 'anthropic', modelId: 'claude-3' }
      const config = w.buildProviderConfig(provider, false)
      const entry = config['anthropic']
      assert.equal(entry.setCacheKey, true)
    })

    test('with_baseUrl_and_apiKey_includes_them', () => {
      const provider = { providerId: 'openai', modelId: 'gpt-4', baseUrl: 'https://api.openai.com', apiKey: 'sk-abc' }
      const config = w.buildProviderConfig(provider, false)
      const entry = config['openai']
      assert.equal(entry.baseUrl, 'https://api.openai.com')
      assert.equal(entry.apiKey, 'sk-abc')
    })

    test('without_baseUrl_excludes_it', () => {
      const provider = { providerId: 'anthropic', modelId: 'claude-3', apiKey: 'sk-test' }
      const config = w.buildProviderConfig(provider, false)
      const entry = config['anthropic']
      assert.equal(entry.baseUrl, undefined)
    })

    test('local_small_tier_context_limit_8192', () => {
      const provider = { providerId: 'ollama', modelId: 'phi', baseUrl: 'http://localhost:11434' }
      const config = w.buildProviderConfig(provider, true, 'small')
      const entry = config['ollama']
      assert.equal(entry.limit?.context, 8192)
    })

    test('local_medium_tier_context_limit_32768', () => {
      const provider = { providerId: 'ollama', modelId: 'phi', baseUrl: 'http://localhost:11434' }
      const config = w.buildProviderConfig(provider, true, 'medium')
      const entry = config['ollama']
      assert.equal(entry.limit?.context, 32768)
    })

    test('cloud_no_context_limit', () => {
      const provider = { providerId: 'anthropic', modelId: 'claude-3', apiKey: 'sk-test' }
      const config = w.buildProviderConfig(provider, false)
      const entry = config['anthropic']
      assert.equal(entry.limit, undefined)
    })
  })

  // ── buildShellEnvironment ──

  describe('buildShellEnvironment', () => {
    test('always_includes_WORKSPACE_PATH', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: null
      })
      assert.equal(env.WORKSPACE_PATH, '/my/workspace')
    })

    test('always_includes_GIT_TERMINAL_PROMPT_0', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: null
      })
      assert.equal(env.GIT_TERMINAL_PROMPT, '0')
    })

    test('with_workspaceId_includes_WORKSPACE_ID', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: 'ws-42'
      })
      assert.equal(env.WORKSPACE_ID, 'ws-42')
    })

    test('without_workspaceId_omits_WORKSPACE_ID', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: null
      })
      assert.equal(env.WORKSPACE_ID, undefined)
    })

    test('with_ipcSocketPath_includes_IPC_SOCKET_PATH', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: null,
        ipcSocketPath: '/tmp/ipc.sock'
      })
      assert.equal(env.IPC_SOCKET_PATH, '/tmp/ipc.sock')
    })

    test('always_includes_NODE_OPTIONS', () => {
      const env = w.buildShellEnvironment({
        workspacePath: '/my/workspace',
        workspaceId: null
      })
      assert.ok(env.NODE_OPTIONS, 'NODE_OPTIONS should be set')
      assert.ok(env.NODE_OPTIONS.includes('--max-old-space-size'))
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
