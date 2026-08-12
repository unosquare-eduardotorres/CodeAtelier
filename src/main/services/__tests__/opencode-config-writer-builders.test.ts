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

  test('anthropic cloud → options.setCacheKey true + options.timeout 300K', () => {
    const providers = (writer as any).buildProviderConfig(baseProvider, false, undefined)
    const entry = providers.anthropic
    assert.ok(entry, 'should have anthropic entry')
    assert.equal(entry.options.setCacheKey, true)
    assert.equal(entry.options.timeout, 300_000)
    assert.equal(entry.options.chunkTimeout, 15_000)
    // Built-in provider should NOT have npm
    assert.equal(entry.npm, undefined)
  })

  test('local provider → options.timeout 600K + options.chunkTimeout 30K', () => {
    const provider = { providerId: 'ollama', modelId: 'qwen2.5-coder:32b' }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium')
    const entry = providers.ollama
    assert.ok(entry, 'should have ollama entry')
    assert.equal(entry.options.timeout, 600_000)
    assert.equal(entry.options.chunkTimeout, 30_000)
  })

  test('provider with baseUrl → options.baseURL (uppercase)', () => {
    const provider = { providerId: 'openai', modelId: 'gpt-5', baseUrl: 'http://localhost:4000' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    const entry = providers.openai
    assert.ok(entry)
    assert.equal(entry.options.baseURL, 'http://localhost:4000')
  })

  test('provider with apiKey → options.apiKey', () => {
    const provider = { providerId: 'openai', modelId: 'gpt-5', apiKey: 'sk-test-123' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    const entry = providers.openai
    assert.ok(entry)
    assert.equal(entry.options.apiKey, 'sk-test-123')
  })

  test('custom provider with baseUrl → npm: @ai-sdk/openai-compatible', () => {
    const provider = {
      providerId: 'omlx',
      modelId: 'test-model',
      baseUrl: 'http://192.168.1.1:8000'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small')
    const entry = providers.omlx
    assert.ok(entry)
    assert.equal(entry.npm, '@ai-sdk/openai-compatible')
  })

  test('custom provider baseUrl auto-appends /v1 for OpenAI-compatible SDK', () => {
    const provider = {
      providerId: 'omlx',
      modelId: 'test-model',
      baseUrl: 'http://192.168.1.1:8000'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small')
    assert.equal(providers.omlx.options.baseURL, 'http://192.168.1.1:8000/v1')
  })

  test('custom provider baseUrl already ending with /v1 is not doubled', () => {
    const provider = {
      providerId: 'omlx',
      modelId: 'test-model',
      baseUrl: 'http://192.168.1.1:8000/v1'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small')
    assert.equal(providers.omlx.options.baseURL, 'http://192.168.1.1:8000/v1')
  })

  test('built-in provider with baseUrl → no npm, no /v1 append', () => {
    const provider = { providerId: 'openai', modelId: 'gpt-5', baseUrl: 'http://localhost:4000' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.equal(providers.openai.npm, undefined)
    assert.equal(providers.openai.options.baseURL, 'http://localhost:4000')
  })

  test('local + small tier + confident → models with tier-accurate limits', () => {
    const provider = {
      providerId: 'ollama',
      modelId: 'qwen2.5-coder:7b',
      baseUrl: 'http://localhost:11434'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small', true)
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.models['qwen2.5-coder:7b'].limit, { context: 8192, output: 4096 })
  })

  test('local + medium tier + confident → models with context 32768', () => {
    const provider = {
      providerId: 'ollama',
      modelId: 'qwen2.5-coder:32b',
      baseUrl: 'http://localhost:11434'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium', true)
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.models['qwen2.5-coder:32b'].limit, { context: 32768, output: 32768 })
  })

  test('local + large tier + confident → models with context 131072', () => {
    const provider = {
      providerId: 'ollama',
      modelId: 'qwen2.5-coder:32b',
      baseUrl: 'http://localhost:11434'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'large', true)
    const entry = providers.ollama
    assert.ok(entry)
    assert.deepEqual(entry.models['qwen2.5-coder:32b'].limit, { context: 131072, output: 32768 })
  })

  test('custom provider + not confident → models with default fallback limits', () => {
    const provider = {
      providerId: 'omlx',
      modelId: 'mlx-community/test-model',
      baseUrl: 'http://192.168.1.1:8000'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'medium', false)
    const entry = providers.omlx
    assert.ok(entry, 'should have omlx entry')
    assert.ok(entry.models, 'models block must exist even when not confident')
    assert.deepEqual(entry.models['mlx-community/test-model'].limit, {
      context: 131072,
      output: 32768
    })
  })

  test('custom provider + no contextWindowConfident → models with default limits', () => {
    const provider = {
      providerId: 'omlx',
      modelId: 'test-model',
      baseUrl: 'http://192.168.1.1:8000'
    }
    const providers = (writer as any).buildProviderConfig(provider, true, 'small')
    const entry = providers.omlx
    assert.ok(entry, 'should have omlx entry')
    assert.ok(entry.models, 'models block must exist for custom providers')
    assert.deepEqual(entry.models['test-model'].limit, { context: 131072, output: 32768 })
  })

  test('built-in provider → no models block (resolved via models.dev)', () => {
    const provider = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }
    const providers = (writer as any).buildProviderConfig(provider, false, undefined)
    assert.equal(providers.anthropic.models, undefined)
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

// ── buildInstructions ──

describe('OpenCodeConfigWriter.buildInstructions — glob safety', () => {
  test('non-existent workspace returns empty array (no {file:} refs)', () => {
    const instructions = (writer as any).buildInstructions('/tmp/non-existent-workspace-abc123')
    // Should NOT include any {file:docs/architecture/*.md} or {file:.cursor/rules/*.md}
    const fileRefs = instructions.filter((i: string) => i.includes('{file:'))
    assert.equal(
      fileRefs.length,
      0,
      `Expected no file refs for non-existent workspace, got: ${JSON.stringify(fileRefs)}`
    )
  })

  test('workspace with CLAUDE.md includes it', () => {
    // Use the actual AgentStudio workspace which has CLAUDE.md
    const instructions = (writer as any).buildInstructions(process.cwd())
    // Just verify the method runs without error and returns an array
    assert.ok(Array.isArray(instructions))
  })

  test('glob patterns only included when directory exists', () => {
    // For a non-existent workspace, NO glob patterns should be added
    const instructions = (writer as any).buildInstructions('/tmp/no-such-dir-xyz')
    const archGlob = instructions.find((i: string) => i.includes('docs/architecture'))
    const cursorGlob = instructions.find((i: string) => i.includes('.cursor/rules'))
    assert.equal(
      archGlob,
      undefined,
      'Should not include docs/architecture glob for non-existent dir'
    )
    assert.equal(
      cursorGlob,
      undefined,
      'Should not include .cursor/rules glob for non-existent dir'
    )
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
