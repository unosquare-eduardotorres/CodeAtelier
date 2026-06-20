/**
 * Unit tests for opencode-config-writer.ts — private pure-logic builder methods.
 *
 * Covers:
 *  - resolveSmallModel (provider → small model mapping)
 *  - buildPermissions (mode → permission config)
 *  - buildCompactionConfig (tier → compaction config)
 *  - buildProviderConfig (provider + isLocal + tier → provider entry)
 *
 * All accessed via `(instance as any).methodName()` — zero FS/DB deps.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeConfigWriter } from '../opencode-config-writer'

const writer = new OpenCodeConfigWriter()

// ── resolveSmallModel ──

describe('OpenCodeConfigWriter.resolveSmallModel', () => {
  test('anthropic → anthropic/claude-haiku-3-5', () => {
    assert.equal((writer as any).resolveSmallModel('anthropic'), 'anthropic/claude-haiku-3-5')
  })

  test('openai → openai/gpt-4o-mini', () => {
    assert.equal((writer as any).resolveSmallModel('openai'), 'openai/gpt-4o-mini')
  })

  test('google → google/gemini-2.0-flash-lite', () => {
    assert.equal((writer as any).resolveSmallModel('google'), 'google/gemini-2.0-flash-lite')
  })

  test('ollama → ollama/qwen3:8b', () => {
    assert.equal((writer as any).resolveSmallModel('ollama'), 'ollama/qwen3:8b')
  })

  test('omlx → undefined (already small)', () => {
    assert.equal((writer as any).resolveSmallModel('omlx'), undefined)
  })

  test('unknown provider → undefined', () => {
    assert.equal((writer as any).resolveSmallModel('some-custom-provider'), undefined)
  })
})

// ── buildPermissions ──

describe('OpenCodeConfigWriter.buildPermissions', () => {
  test('build mode → all "allow" + task "allow"', () => {
    const perms = (writer as any).buildPermissions('build')
    assert.equal(perms.Write, 'allow')
    assert.equal(perms.Edit, 'allow')
    assert.equal(perms.Bash, 'allow')
    assert.equal(perms.Read, 'allow')
    assert.equal(perms.task, 'allow')
  })

  test('plan mode → Write/Edit "ask", Bash has glob patterns, task "deny"', () => {
    const perms = (writer as any).buildPermissions('plan')
    assert.equal(perms.Write, 'ask')
    assert.equal(perms.Edit, 'ask')
    // Bash should be an object with glob patterns
    assert.equal(typeof perms.Bash, 'object')
    assert.equal(perms.Bash['*'], 'ask')
    assert.equal(perms.Bash['git status *'], 'allow')
    assert.equal(perms.task, 'deny')
    // Read-only tools still allowed
    assert.equal(perms.Read, 'allow')
    assert.equal(perms.Glob, 'allow')
    assert.equal(perms.Grep, 'allow')
  })

  test('danger mode → same as build (all allow)', () => {
    const perms = (writer as any).buildPermissions('danger')
    assert.equal(perms.Write, 'allow')
    assert.equal(perms.Edit, 'allow')
    assert.equal(perms.Bash, 'allow')
    assert.equal(perms.task, 'allow')
  })
})

// ── buildCompactionConfig ──

describe('OpenCodeConfigWriter.buildCompactionConfig', () => {
  test('small tier → reserved 4096', () => {
    const config = (writer as any).buildCompactionConfig('small')
    assert.equal(config.enabled, true)
    assert.equal(config.auto, true)
    assert.equal(config.prune, true)
    assert.equal(config.reserved, 4096)
  })

  test('medium tier → reserved 8192', () => {
    const config = (writer as any).buildCompactionConfig('medium')
    assert.equal(config.reserved, 8192)
  })

  test('large tier → reserved 16384', () => {
    const config = (writer as any).buildCompactionConfig('large')
    assert.equal(config.reserved, 16384)
  })

  test('undefined tier → defaults to 8192 (cloud conservative)', () => {
    const config = (writer as any).buildCompactionConfig(undefined)
    assert.equal(config.reserved, 8192)
    assert.equal(config.enabled, true)
  })
})

// ── buildProviderConfig ──

describe('OpenCodeConfigWriter.buildProviderConfig', () => {
  const baseProvider = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }

  test('anthropic cloud → setCacheKey true + timeout 300K', () => {
    const providers = (writer as any).buildProviderConfig(baseProvider, false, undefined)
    const entry = providers.anthropic
    assert.ok(entry, 'should have anthropic entry')
    assert.equal(entry.setCacheKey, true)
    assert.equal(entry.timeout, 300_000)
    assert.equal(entry.chunkTimeout, 15_000)
  })

  test('local provider → timeout 600K + chunkTimeout 30K', () => {
    const provider = { providerId: 'ollama', modelId: 'qwen2.5-coder:32b' }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium')
    const entry = providers.ollama
    assert.ok(entry, 'should have ollama entry')
    assert.equal(entry.timeout, 600_000)
    assert.equal(entry.chunkTimeout, 30_000)
  })

  test('provider with baseUrl → includes baseUrl', () => {
    const provider = { providerId: 'openai', modelId: 'gpt-5', baseUrl: 'http://localhost:4000' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    const entry = providers.openai
    assert.ok(entry)
    assert.equal(entry.baseUrl, 'http://localhost:4000')
  })

  test('provider with apiKey → includes apiKey', () => {
    const provider = { providerId: 'openai', modelId: 'gpt-5', apiKey: 'sk-test-123' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    const entry = providers.openai
    assert.ok(entry)
    assert.equal(entry.apiKey, 'sk-test-123')
  })

  test('local + small tier → limit.context 8192', () => {
    const provider = { providerId: 'ollama', modelId: 'qwen2.5-coder:7b' }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small')
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.limit, { context: 8192 })
  })

  test('local + medium tier → limit.context 32768', () => {
    const provider = { providerId: 'ollama', modelId: 'qwen2.5-coder:32b' }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium')
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.limit, { context: 32768 })
  })

  test('local + large tier → limit.context 131072', () => {
    const provider = { providerId: 'ollama', modelId: 'qwen2.5-coder:32b' }
    const providers = (writer as any).buildProviderConfig(provider, true, 'large')
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.limit, { context: 131072 })
  })

  test('non-anthropic, non-local, no baseUrl/apiKey → empty providers', () => {
    const provider = { providerId: 'google', modelId: 'gemini-2.0' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.deepEqual(providers, {})
  })
})

// ── Plan-mode Bash glob detail ──

describe('OpenCodeConfigWriter.buildPermissions — plan-mode Bash globs', () => {
  const perms = (writer as any).buildPermissions('plan')
  const bash = perms.Bash as Record<string, string>

  test('git status → allow', () => {
    assert.equal(bash['git status *'], 'allow')
  })

  test('git log → allow', () => {
    assert.equal(bash['git log *'], 'allow')
  })

  test('npm test → allow', () => {
    assert.equal(bash['npm test *'], 'allow')
  })

  test('cat → allow', () => {
    assert.equal(bash['cat *'], 'allow')
  })

  test('head → allow', () => {
    assert.equal(bash['head *'], 'allow')
  })

  test('find → allow', () => {
    assert.equal(bash['find *'], 'allow')
  })

  test('default * → ask (catches rm, mv, etc.)', () => {
    assert.equal(bash['*'], 'ask')
  })
})

// ── Plan-mode tool blocking ──

describe('OpenCodeConfigWriter.buildPermissions — plan-mode tool blocking', () => {
  const perms = (writer as any).buildPermissions('plan')

  test('Write → ask in plan mode', () => {
    assert.equal(perms.Write, 'ask')
  })

  test('Edit → ask in plan mode', () => {
    assert.equal(perms.Edit, 'ask')
  })

  test('task → deny in plan mode (B-7: block subagent invocation)', () => {
    assert.equal(perms.task, 'deny')
  })

  test('external_directory → deny in plan mode (B-7)', () => {
    assert.equal(perms.external_directory, 'deny')
  })

  test('doom_loop → allow even in plan mode (C-3)', () => {
    assert.equal(perms.doom_loop, 'allow')
  })
})

// ── Build-mode all-allow ──

describe('OpenCodeConfigWriter.buildPermissions — build-mode all-allow', () => {
  const perms = (writer as any).buildPermissions('build')

  test('all write/exec permissions are allow', () => {
    assert.equal(perms.Write, 'allow')
    assert.equal(perms.Edit, 'allow')
    assert.equal(perms.Bash, 'allow')
    assert.equal(perms.Read, 'allow')
    assert.equal(perms.Glob, 'allow')
    assert.equal(perms.Grep, 'allow')
  })

  test('task and doom_loop are allow in build mode', () => {
    assert.equal(perms.task, 'allow')
    assert.equal(perms.doom_loop, 'allow')
  })

  test('web tools are allow in build mode', () => {
    assert.equal(perms.websearch, 'allow')
    assert.equal(perms.webfetch, 'allow')
  })

  test('skill and lsp are allow in build mode', () => {
    assert.equal(perms.skill, 'allow')
    assert.equal(perms.lsp, 'allow')
    assert.equal(perms.todowrite, 'allow')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
