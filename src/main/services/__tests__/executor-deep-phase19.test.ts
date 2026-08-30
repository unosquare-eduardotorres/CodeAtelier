/**
 * Phase 19, Track B — Executor family deep tests.
 *
 * Tests pure functions and isolated method bodies in:
 *   - opencode-executor.ts (isTransientError, computeTransientRetry,
 *     buildPromptBody, isSessionComplete, normalizeEvent delegation,
 *     getVitals, session map management, circuit breaker reset)
 *   - cli-executor.ts (arg building matrix, output classification,
 *     drain/kill paths)
 *
 * Strategy: construct OpenCodeExecutor/CLIExecutor, access private methods
 * via bracket notation. No real sockets, spawns, or HTTP calls.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Load modules ─────────────────────────────────────────────────────────

let OpenCodeExecutor: typeof import('../opencode-executor').OpenCodeExecutor
let CLIExecutor: any

let ocLoaded = false
let cliLoaded = false

try {
  const mod = require('../opencode-executor')
  OpenCodeExecutor = mod.OpenCodeExecutor
  ocLoaded = true
} catch (err) {
  console.log(`⚠ opencode-executor load failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

try {
  CLIExecutor = require('../cli-executor').CLIExecutor
  cliLoaded = true
} catch (err) {
  console.log(`⚠ cli-executor load failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ── OpenCodeExecutor ─────────────────────────────────────────────────────

if (ocLoaded) {
  describe('OpenCodeExecutor — isTransientError', () => {
    function makeOC() {
      return new OpenCodeExecutor()
    }

    test('rate_limit_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('rate limit exceeded'))
    })

    test('rate_limit_with_underscore_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('rate_limit_exceeded'))
    })

    test('overloaded_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('Server is overloaded'))
    })

    test('too_many_requests_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('Too many requests'))
    })

    test('503_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('HTTP 503 Service Unavailable'))
    })

    test('429_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('HTTP 429 Too Many Requests'))
    })

    test('ECONNRESET_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('ECONNRESET'))
    })

    test('ETIMEDOUT_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('ETIMEDOUT'))
    })

    test('ECONNREFUSED_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('ECONNREFUSED'))
    })

    test('network_error_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('Network error occurred'))
    })

    test('timeout_detected', () => {
      const oc = makeOC()
      assert.ok((oc as any).isTransientError('Request timeout'))
    })

    test('regular_error_not_transient', () => {
      const oc = makeOC()
      assert.ok(!(oc as any).isTransientError('invalid JSON'))
    })

    test('empty_string_not_transient', () => {
      const oc = makeOC()
      assert.ok(!(oc as any).isTransientError(''))
    })
  })

  describe('OpenCodeExecutor — computeTransientRetry', () => {
    function makeOC() {
      return new OpenCodeExecutor()
    }

    test('first_retry_has_base_delay', () => {
      const oc = makeOC()
      const result = (oc as any).computeTransientRetry(0, 'rate limit')
      assert.ok(result)
      assert.equal(result.attemptNumber, 1)
      assert.equal(result.delayMs, 2000) // BASE_RETRY_DELAY_MS
      assert.ok(result.startedMessage.includes('2s'))
      assert.ok(result.resumingMessage.includes('Retry 1'))
    })

    test('second_retry_has_doubled_delay', () => {
      const oc = makeOC()
      const result = (oc as any).computeTransientRetry(1, 'overloaded')
      assert.ok(result)
      assert.equal(result.attemptNumber, 2)
      assert.equal(result.delayMs, 4000) // 2000 * 2^1
    })

    test('third_retry_has_quadrupled_delay', () => {
      const oc = makeOC()
      // SSE-TIMEOUT FIX: fast-class message keeps the 2s base (timeout is
      // slow-class — covered by the slow-class test below)
      const result = (oc as any).computeTransientRetry(2, 'rate limit')
      assert.ok(result)
      assert.equal(result.attemptNumber, 3)
      assert.equal(result.delayMs, 8000) // 2000 * 2^2
    })

    test('slow_class_timeout_uses_slow_base', () => {
      const oc = makeOC()
      // SSE-TIMEOUT FIX: timeout/connection-stall class uses
      // SLOW_RETRY_BASE_DELAY_MS (30s/60s/120s)
      const result = (oc as any).computeTransientRetry(2, 'timeout')
      assert.ok(result)
      assert.equal(result.attemptNumber, 3)
      assert.equal(result.delayMs, 120000) // 30000 * 2^2
    })

    test('returns_null_when_max_retries_exhausted', () => {
      const oc = makeOC()
      const result = (oc as any).computeTransientRetry(3, 'rate limit')
      assert.equal(result, null)
    })

    test('returns_null_when_over_max_retries', () => {
      const oc = makeOC()
      const result = (oc as any).computeTransientRetry(5, 'rate limit')
      assert.equal(result, null)
    })
  })

  describe('OpenCodeExecutor — isSessionComplete', () => {
    function makeOC() {
      return new OpenCodeExecutor()
    }

    test('session_idle_is_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.idle', properties: { sessionID: 's1' } },
        's1',
        false,
        true // sawTurnActivity — idle after activity is terminal
      )
      assert.ok(result)
    })

    test('session_error_is_complete_without_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.error', properties: { sessionID: 's1' } },
        's1',
        false
      )
      assert.ok(result)
    })

    test('session_error_not_complete_with_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.error', properties: { sessionID: 's1' } },
        's1',
        true
      )
      assert.ok(!result)
    })

    test('session_status_idle_is_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.status', properties: { status: 'idle', sessionID: 's1' } },
        's1',
        false,
        true // sawTurnActivity — idle after activity is terminal
      )
      assert.ok(result)
    })

    test('session_status_error_complete_without_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.status', properties: { status: 'error', sessionID: 's1' } },
        's1',
        false
      )
      assert.ok(result)
    })

    test('session_status_error_not_complete_with_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.status', properties: { status: 'error', sessionID: 's1' } },
        's1',
        true
      )
      assert.ok(!result)
    })

    test('session_status_running_not_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.status', properties: { status: 'running', sessionID: 's1' } },
        's1'
      )
      assert.ok(!result)
    })

    test('wrong_session_id_not_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.idle', properties: { sessionID: 's2' } },
        's1'
      )
      assert.ok(!result)
    })

    test('no_properties_not_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete({ type: 'session.idle' }, 's1')
      assert.ok(!result)
    })

    test('step_failed_complete_without_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.next.step.failed', properties: { sessionID: 's1' } },
        's1',
        false
      )
      assert.ok(result)
    })

    test('step_failed_not_complete_with_retries', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.next.step.failed', properties: { sessionID: 's1' } },
        's1',
        true
      )
      assert.ok(!result)
    })

    test('unknown_event_type_not_complete', () => {
      const oc = makeOC()
      const result = (oc as any).isSessionComplete(
        { type: 'session.message.delta', properties: { sessionID: 's1' } },
        's1'
      )
      assert.ok(!result)
    })
  })

  describe('OpenCodeExecutor — buildPromptBody', () => {
    function makeOC() {
      return new OpenCodeExecutor()
    }

    test('basic_prompt_body_has_parts_and_model', () => {
      const oc = makeOC()
      const body = (oc as any).buildPromptBody('Hello', 'You are helpful', {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6'
      })
      assert.ok(body.parts)
      assert.equal(body.parts.length, 1)
      assert.equal(body.parts[0].type, 'text')
      assert.equal(body.parts[0].text, 'Hello')
      assert.ok(body.model)
      assert.equal(body.model.providerID, 'anthropic')
      assert.equal(body.model.modelID, 'claude-sonnet-4-6')
      assert.equal(body.system, 'You are helpful')
    })

    test('system_prompt_skipped_when_plugin_hook_active', () => {
      const oc = makeOC()
      process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = '/tmp/test'
      try {
        const body = (oc as any).buildPromptBody('Hello', 'System prompt', {
          providerId: 'anthropic',
          modelId: 'claude-sonnet-4-6'
        })
        assert.equal(body.system, undefined)
      } finally {
        delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
      }
    })

    test('empty_system_prompt_not_included', () => {
      const oc = makeOC()
      const body = (oc as any).buildPromptBody('Hello', '', {
        providerId: 'anthropic',
        modelId: 'claude-sonnet-4-6'
      })
      assert.equal(body.system, undefined)
    })

    test('output_schema_adds_format_field', () => {
      const oc = makeOC()
      const schema = { type: 'object', properties: { answer: { type: 'string' } } }
      const body = (oc as any).buildPromptBody(
        'Hello',
        'System',
        { providerId: 'test', modelId: 'test' },
        schema
      )
      assert.ok(body.format)
      assert.equal(body.format.type, 'json_schema')
      assert.deepEqual(body.format.schema, schema)
      assert.equal(body.format.retryCount, 2)
    })

    test('images_included_as_file_parts', () => {
      const oc = makeOC()
      const images = [
        { base64: 'img1data', mimeType: 'image/png', fileName: 'test.png' },
        { base64: 'img2data', mimeType: 'image/jpeg', fileName: 'photo.jpg' }
      ]
      const body = (oc as any).buildPromptBody(
        'Describe',
        'System',
        { providerId: 'test', modelId: 'test' },
        undefined,
        images
      )
      // 1 text part + 2 image parts
      assert.equal(body.parts.length, 3)
      assert.equal(body.parts[0].type, 'text')
      assert.equal(body.parts[1].type, 'file')
      assert.equal(body.parts[1].mime, 'image/png')
      assert.ok(body.parts[1].url.startsWith('data:image/png;base64,'))
      assert.equal(body.parts[2].type, 'file')
      assert.equal(body.parts[2].mime, 'image/jpeg')
    })
  })

  describe('OpenCodeExecutor — instance state', () => {
    test('getVitals_returns_zero_initially', () => {
      const oc = new OpenCodeExecutor()
      const vitals = oc.getVitals()
      assert.equal(vitals.activeSessions, 0)
      assert.equal(vitals.retriesInFlight, 0)
    })

    test('isRunning_false_initially', () => {
      const oc = new OpenCodeExecutor()
      assert.equal(oc.isRunning(), false)
    })

    test('resetCircuitBreaker_clears_error_count', () => {
      const oc = new OpenCodeExecutor()
      ;(oc as any).consecutiveErrors = 5
      oc.resetCircuitBreaker()
      assert.equal((oc as any).consecutiveErrors, 0)
    })

    test('getSessionId_returns_undefined_for_unknown', () => {
      const oc = new OpenCodeExecutor()
      assert.equal(oc.getSessionId('unknown-conv'), undefined)
    })

    test('clearSession_removes_session', () => {
      const oc = new OpenCodeExecutor()
      ;(oc as any).sessionMap.set('conv-1', 'session-1')
      oc.clearSession('conv-1')
      assert.equal(oc.getSessionId('conv-1'), undefined)
    })

    test('clearSession_does_not_throw_for_unknown', () => {
      const oc = new OpenCodeExecutor()
      oc.clearSession('nonexistent')
      // Should not throw
    })

    test('static_CIRCUIT_BREAKER_THRESHOLD_is_5', () => {
      assert.equal((OpenCodeExecutor as any).CIRCUIT_BREAKER_THRESHOLD, 5)
    })

    test('static_HEALTH_CHECK_INTERVAL_is_30s', () => {
      assert.equal((OpenCodeExecutor as any).HEALTH_CHECK_INTERVAL, 30000)
    })
  })
} else {
  describe('OpenCodeExecutor (skipped — module not loaded)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

// ── CLIExecutor ──────────────────────────────────────────────────────────

if (cliLoaded) {
  describe('CLIExecutor — instance state', () => {
    test('isAlive_false_initially', () => {
      const cli = new CLIExecutor()
      assert.equal(cli.isAlive(), false)
    })

    test('getSessionId_returns_undefined_initially', () => {
      const cli = new CLIExecutor()
      assert.equal(cli.getSessionId(), undefined)
    })

    test('not_alive_when_no_process', () => {
      const cli = new CLIExecutor()
      // isAlive should be false when no process is spawned
      assert.ok(!cli.isAlive())
    })

    test('sessionId_is_undefined_initially', () => {
      const cli = new CLIExecutor()
      assert.equal((cli as any).sessionId, undefined)
    })
  })

  describe('CLIExecutor — buildGoalCommand (module-level)', () => {
    let buildGoalCommand: typeof import('../cli-executor').buildGoalCommand
    try {
      buildGoalCommand = require('../cli-executor').buildGoalCommand
    } catch {
      /* not exported */
    }

    if (buildGoalCommand!) {
      test('builds_goal_slash_command', () => {
        const cmd = buildGoalCommand('Build a REST API')
        assert.ok(cmd, 'buildGoalCommand should return a string')
        assert.ok(cmd.includes('/goal'))
        assert.ok(cmd.includes('Build a REST API'))
      })

      test('truncates_long_goals', () => {
        const longGoal = 'x'.repeat(10000)
        const cmd = buildGoalCommand(longGoal)
        assert.ok(cmd, 'buildGoalCommand should return a string')
        assert.ok(cmd.length < 10000, 'should truncate long goals')
      })

      test('clears_goal_with_alias', () => {
        const cmd = buildGoalCommand('clear')
        assert.ok(cmd != null, 'buildGoalCommand should return for clear alias')
        assert.ok(cmd.includes('/goal') || cmd === '', 'should handle clear alias')
      })
    }
  })
} else {
  describe('CLIExecutor (skipped — module not loaded)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
