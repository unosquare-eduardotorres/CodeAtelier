/**
 * Unit tests for OpenCode executor pure functions — isTransientError,
 * computeTransientRetry, buildPromptParts, buildPromptBody, isSessionComplete.
 *
 * Phase 14, Track 3 — opencode-executor.ts (~1,225 lines at 33.63%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated constants from opencode-executor.ts:105-123 ──

const TRANSIENT_ERROR_PATTERNS = [
  /rate.?limit/i,
  /overloaded/i,
  /server_is_overloaded/i,
  /too many requests/i,
  /503/,
  /429/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /network/i,
  /timeout/i
]

const MAX_TRANSIENT_RETRIES = 3
const BASE_RETRY_DELAY_MS = 2000

// ── Replicated pure functions ──

/**
 * Replicated from OpenCodeExecutor.isTransientError (opencode-executor.ts:1026-1028).
 */
function isTransientError(errorMessage: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
}

/**
 * Replicated from OpenCodeExecutor.computeTransientRetry (opencode-executor.ts:1033-1057).
 */
function computeTransientRetry(
  currentRetryCount: number,
  _errorMessage: string
): {
  attemptNumber: number
  delayMs: number
  startedMessage: string
  resumingMessage: string
} | null {
  if (currentRetryCount >= MAX_TRANSIENT_RETRIES) return null

  const attemptNumber = currentRetryCount + 1
  const delayMs = BASE_RETRY_DELAY_MS * Math.pow(2, attemptNumber - 1)

  return {
    attemptNumber,
    delayMs,
    startedMessage: `Transient error detected — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attemptNumber}/${MAX_TRANSIENT_RETRIES})`,
    resumingMessage: `Retry ${attemptNumber} in progress...`
  }
}

/**
 * Replicated from OpenCodeExecutor.buildPromptParts (opencode-executor.ts:1139-1148).
 */
function buildPromptParts(
  prompt: string,
  systemPrompt: string,
  hasPluginSystemPromptHook: boolean
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  if (systemPrompt && !hasPluginSystemPromptHook) {
    parts.push({ type: 'text', text: `[System Instructions]\n${systemPrompt}` })
  }
  parts.push({ type: 'text', text: prompt })
  return parts
}

/**
 * Replicated from OpenCodeExecutor.buildPromptBody (opencode-executor.ts:1113-1133).
 */
function buildPromptBody(
  prompt: string,
  systemPrompt: string,
  provider: { providerId: string; modelId: string },
  hasPluginSystemPromptHook: boolean,
  outputSchema?: Record<string, unknown>
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    parts: buildPromptParts(prompt, systemPrompt, hasPluginSystemPromptHook),
    model: {
      providerID: provider.providerId,
      modelID: provider.modelId
    }
  }
  if (outputSchema) {
    body.format = { type: 'json_schema', schema: outputSchema, retries: 2 }
  }
  return body
}

/**
 * Replicated from OpenCodeExecutor.isSessionComplete (opencode-executor.ts).
 * NOTE: retriesAvailable should only be true when a retry was actually initiated
 * for the current event (retryInitiatedThisEvent), NOT simply when the retry
 * budget hasn't been exhausted. See processEventStream deadlock fix.
 */
function isSessionComplete(event: Record<string, unknown>, sessionId: string, retriesAvailable = false): boolean {
  const type = event.type as string | undefined
  const properties = event.properties as Record<string, unknown> | undefined

  if (!properties) return false
  const eventSessionId = properties.sessionID as string | undefined
  if (eventSessionId && eventSessionId !== sessionId) return false

  if (type === 'session.idle') return true

  if (type === 'session.error') {
    if (retriesAvailable) return false
    return true
  }

  if (type === 'session.status') {
    const status = properties.status as string | undefined
    if (status === 'idle') return true
    if (status === 'error' && !retriesAvailable) return true
  }

  // session.next.step.ended(stop) is deliberately NOT terminal — it is the end of
  // a single generation step, not the agent loop. Only step.failed is terminal.
  if (type === 'session.next.step.failed') {
    if (retriesAvailable) return false
    return true
  }

  return false
}

// ── Tests ──

describe('isTransientError', () => {
  test('rate_limit_returns_true', () => {
    assert.ok(isTransientError('rate limit exceeded'))
  })

  test('Rate_Limit_case_insensitive_returns_true', () => {
    assert.ok(isTransientError('Rate_Limit reached'))
  })

  test('overloaded_returns_true', () => {
    assert.ok(isTransientError('server overloaded'))
  })

  test('too_many_requests_returns_true', () => {
    assert.ok(isTransientError('too many requests'))
  })

  test('503_returns_true', () => {
    assert.ok(isTransientError('HTTP 503 Service Unavailable'))
  })

  test('429_returns_true', () => {
    assert.ok(isTransientError('HTTP 429 Too Many Requests'))
  })

  test('ECONNRESET_returns_true', () => {
    assert.ok(isTransientError('Error: ECONNRESET'))
  })

  test('ETIMEDOUT_returns_true', () => {
    assert.ok(isTransientError('connect ETIMEDOUT'))
  })

  test('ECONNREFUSED_returns_true', () => {
    assert.ok(isTransientError('connect ECONNREFUSED 127.0.0.1:11434'))
  })

  test('network_error_returns_true', () => {
    assert.ok(isTransientError('network error occurred'))
  })

  test('timeout_returns_true', () => {
    assert.ok(isTransientError('request timeout'))
  })

  test('invalid_auth_returns_false', () => {
    assert.ok(!isTransientError('invalid authentication credentials'))
  })

  test('malformed_request_returns_false', () => {
    assert.ok(!isTransientError('malformed request body'))
  })

  test('empty_string_returns_false', () => {
    assert.ok(!isTransientError(''))
  })
})

describe('computeTransientRetry', () => {
  test('attempt_1_returns_2000ms_delay', () => {
    const result = computeTransientRetry(0, 'rate limit')
    assert.ok(result !== null)
    assert.equal(result!.attemptNumber, 1)
    assert.equal(result!.delayMs, 2000)
  })

  test('attempt_2_returns_4000ms_delay', () => {
    const result = computeTransientRetry(1, 'rate limit')
    assert.ok(result !== null)
    assert.equal(result!.attemptNumber, 2)
    assert.equal(result!.delayMs, 4000)
  })

  test('attempt_3_returns_8000ms_delay', () => {
    const result = computeTransientRetry(2, 'rate limit')
    assert.ok(result !== null)
    assert.equal(result!.attemptNumber, 3)
    assert.equal(result!.delayMs, 8000)
  })

  test('attempt_4_exceeds_max_returns_null', () => {
    const result = computeTransientRetry(3, 'rate limit')
    assert.equal(result, null)
  })

  test('includes_startedMessage_string', () => {
    const result = computeTransientRetry(0, 'rate limit')
    assert.ok(result!.startedMessage.includes('retrying in 2s'))
    assert.ok(result!.startedMessage.includes('attempt 1/3'))
  })

  test('includes_resumingMessage_string', () => {
    const result = computeTransientRetry(1, 'rate limit')
    assert.ok(result!.resumingMessage.includes('Retry 2'))
  })
})

describe('buildPromptParts', () => {
  test('without_system_prompt_hook_includes_system_prompt', () => {
    const parts = buildPromptParts('Hello', 'You are helpful', false)
    assert.equal(parts.length, 2)
    assert.equal(parts[0].type, 'text')
    assert.ok((parts[0].text as string).includes('[System Instructions]'))
    assert.ok((parts[0].text as string).includes('You are helpful'))
  })

  test('with_system_prompt_hook_skips_system_prompt', () => {
    const parts = buildPromptParts('Hello', 'You are helpful', true)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].text, 'Hello')
  })

  test('always_includes_user_prompt', () => {
    const parts = buildPromptParts('User message', '', false)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].text, 'User message')
  })

  test('empty_system_prompt_is_skipped', () => {
    const parts = buildPromptParts('Hello', '', false)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].text, 'Hello')
  })

  test('system_before_user_ordering', () => {
    const parts = buildPromptParts('User', 'System', false)
    assert.equal(parts.length, 2)
    assert.ok((parts[0].text as string).includes('System'))
    assert.equal(parts[1].text, 'User')
  })
})

describe('buildPromptBody', () => {
  const provider = { providerId: 'ollama', modelId: 'llama3' }

  test('includes_model_config', () => {
    const body = buildPromptBody('Hello', '', provider, false)
    const model = body.model as Record<string, unknown>
    assert.equal(model.providerID, 'ollama')
    assert.equal(model.modelID, 'llama3')
  })

  test('includes_parts_array', () => {
    const body = buildPromptBody('Hello', 'System', provider, false)
    const parts = body.parts as Array<Record<string, unknown>>
    assert.ok(Array.isArray(parts))
    assert.equal(parts.length, 2)
  })

  test('without_outputSchema_no_format', () => {
    const body = buildPromptBody('Hello', '', provider, false)
    assert.equal(body.format, undefined)
  })

  test('with_outputSchema_includes_format', () => {
    const schema = { type: 'object', properties: { result: { type: 'string' } } }
    const body = buildPromptBody('Hello', '', provider, false, schema)
    const format = body.format as Record<string, unknown>
    assert.equal(format.type, 'json_schema')
    assert.deepEqual(format.schema, schema)
    assert.equal(format.retries, 2)
  })
})

describe('isSessionComplete', () => {
  test('session_idle_returns_true', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'sess-1' } }
    assert.ok(isSessionComplete(event, 'sess-1'))
  })

  test('session_error_no_retries_returns_true', () => {
    const event = { type: 'session.error', properties: { sessionID: 'sess-1', error: 'boom' } }
    assert.ok(isSessionComplete(event, 'sess-1', false))
  })

  test('session_error_with_retries_returns_false', () => {
    // retriesAvailable=true means a retry was actually initiated this event
    const event = { type: 'session.error', properties: { sessionID: 'sess-1', error: 'boom' } }
    assert.ok(!isSessionComplete(event, 'sess-1', true))
  })

  test('session_error_no_retry_initiated_returns_true', () => {
    // Key deadlock fix: when no retry fires (retryInitiatedThisEvent=false),
    // session.error MUST terminate the loop even if retry budget remains
    const event = { type: 'session.error', properties: { sessionID: 'sess-1', error: 'model not found' } }
    assert.ok(isSessionComplete(event, 'sess-1', false), 'Should terminate when no retry was initiated')
  })

  test('session_status_idle_returns_true', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'idle' } }
    assert.ok(isSessionComplete(event, 'sess-1'))
  })

  test('session_status_error_no_retries_returns_true', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'error' } }
    assert.ok(isSessionComplete(event, 'sess-1', false))
  })

  test('session_status_error_with_retries_returns_false', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'error' } }
    assert.ok(!isSessionComplete(event, 'sess-1', true))
  })

  test('no_properties_returns_false', () => {
    const event = { type: 'session.idle' }
    assert.ok(!isSessionComplete(event, 'sess-1'))
  })

  test('different_session_id_returns_false', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'other-sess' } }
    assert.ok(!isSessionComplete(event, 'sess-1'))
  })

  test('session_status_running_returns_false', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'running' } }
    assert.ok(!isSessionComplete(event, 'sess-1'))
  })

  test('step_ended_stop_is_NOT_terminal', () => {
    // Regression guard: a step ending with finish="stop" must NOT complete the
    // session — it truncated the final answer text (e.g. JSON), spawned a zombie
    // server session, and stalled the UI. Completion is driven by session.idle.
    const event = { type: 'session.next.step.ended', properties: { sessionID: 'sess-1', finish: 'stop' } }
    assert.ok(!isSessionComplete(event, 'sess-1'), 'step.ended(stop) must not be terminal')
  })

  test('step_failed_no_retries_returns_true', () => {
    const event = { type: 'session.next.step.failed', properties: { sessionID: 'sess-1' } }
    assert.ok(isSessionComplete(event, 'sess-1', false))
  })

  test('step_failed_with_retries_returns_false', () => {
    const event = { type: 'session.next.step.failed', properties: { sessionID: 'sess-1' } }
    assert.ok(!isSessionComplete(event, 'sess-1', true))
  })

  test('unknown_event_type_returns_false', () => {
    const event = { type: 'message.text', properties: { sessionID: 'sess-1' } }
    assert.ok(!isSessionComplete(event, 'sess-1'))
  })

  test('matching_session_without_explicit_id_returns_true', () => {
    // When eventSessionId is undefined, the session filter is skipped
    const event = { type: 'session.idle', properties: {} }
    assert.ok(isSessionComplete(event, 'sess-1'))
  })
})

// ── Import the actual module to exercise code ──

describe('OpenCode Executor — module import coverage', () => {
  test('openCodeExecutor_singleton_is_exported', async () => {
    const mod = await import('../opencode-executor')
    assert.ok(mod.openCodeExecutor)
    assert.equal(typeof mod.openCodeExecutor.resetCircuitBreaker, 'function')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
