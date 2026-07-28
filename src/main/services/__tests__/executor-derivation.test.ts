/**
 * Executor derivation unit tests.
 *
 * Validates the Phase A rule: provider === 'claude' → 'cli'; everything else → 'opencode'.
 * Tests both getExecutorBackend() in model-config.service and resolveExecutorBackend() in
 * agent-session.service.
 *
 * Key scenarios:
 *   - Provider → executor mapping matrix
 *   - Stale settings_json.executorBackend values (e.g. 'codex') are ignored, not crashed
 *   - Undefined/null provider defaults to 'claude' → 'cli'
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { modelConfigService } from '../model-config.service'
import { AgentSessionService } from '../agent-session.service'

// ── modelConfigService.getExecutorBackend ────────────────────────────

describe('modelConfigService.getExecutorBackend — derivation', () => {
  test('returns_cli_when_no_workspacePath', () => {
    const result = modelConfigService.getExecutorBackend(undefined)
    assert.equal(result, 'cli', 'No workspace → default to cli')
  })

  test('returns_cli_or_opencode_for_any_workspace', () => {
    // Without a real workspace, provider defaults to 'claude' → 'cli'
    const result = modelConfigService.getExecutorBackend('/nonexistent/path')
    assert.ok(result === 'cli' || result === 'opencode', `Got valid backend: ${result}`)
  })

  test('return_type_is_string', () => {
    const result = modelConfigService.getExecutorBackend(undefined)
    assert.equal(typeof result, 'string')
  })
})

// ── AgentSessionService.resolveExecutorBackend ───────────────────────

function createMinimalAdapter(): unknown {
  return {
    role: 'project-specialist',
    buildPrompts: () => ({ systemPrompt: '', effectiveMessage: '' }),
    onSessionStart: async () => {},
    onSendComplete: () => {},
    onModeSwitch: () => {},
    onCompact: () => {},
    onStop: () => {},
    assembleSystemPrompt: () => '',
    persona: null
  }
}

describe('resolveExecutorBackend — provider→executor derivation matrix', () => {
  test('claude → cli', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    assert.equal(resolve('claude'), 'cli')
  })

  test('local-llm → opencode', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    assert.equal(resolve('local-llm'), 'opencode')
  })

  test('undefined falls back to session llmProvider (claude default → cli)', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    assert.equal(resolve(undefined), 'cli')
  })

  test('undefined with session llmProvider=local-llm → opencode', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    ;(session as any).llmProvider = 'local-llm'
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    assert.equal(resolve(undefined), 'opencode')
  })

  test('any future non-claude provider → opencode', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    // Hypothetical future providers should all map to opencode
    for (const provider of ['openai', 'google', 'custom', 'azure']) {
      const result = resolve(provider)
      assert.equal(result, 'opencode', `Provider '${provider}' should derive to 'opencode'`)
    }
  })
})

describe('resolveExecutorBackend — stale settings_json tolerance', () => {
  test('session with stale executorBackend=codex does not crash', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    // Simulate a stale setting from before Codex removal
    ;(session as any).executorBackend = 'codex' as any
    // resolveExecutorBackend should derive from provider, ignoring the stale value
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    assert.equal(resolve('claude'), 'cli', 'claude always → cli regardless of stale setting')
    assert.equal(resolve('local-llm'), 'opencode', 'local-llm always → opencode')
  })

  test('executorBackend property defaults to cli', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    assert.equal((session as any).executorBackend, 'cli')
  })
})

// ── ExecutorBackend type narrowing ───────────────────────────────────

describe('ExecutorBackend type — only cli and opencode', () => {
  test('getExecutorBackend never returns codex', () => {
    const result = modelConfigService.getExecutorBackend(undefined)
    assert.notEqual(result, 'codex', 'codex is no longer a valid ExecutorBackend')
  })

  test('resolveExecutorBackend output is always cli or opencode', () => {
    const session = new AgentSessionService(createMinimalAdapter() as any)
    const resolve = (session as any).resolveExecutorBackend.bind(session)
    for (const input of ['claude', 'local-llm', undefined, 'openai', 'unknown']) {
      const result = resolve(input)
      assert.ok(
        result === 'cli' || result === 'opencode',
        `resolve('${input}') returned '${result}' — must be 'cli' or 'opencode'`
      )
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
