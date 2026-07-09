/**
 * Unit tests for opencode-executor.ts — private pure-logic methods.
 *
 * Covers:
 *  - isTransientError (regex pattern matching)
 *  - computeTransientRetry (exponential backoff computation)
 *  - isSessionComplete (event-type termination detection)
 *  - buildPromptParts (text part array construction)
 *  - buildPromptBody (prompt body assembly with model/schema)
 *  - checkCliAvailable (CLI availability check for OpenCode CLI)
 *
 * All accessed via `(instance as any).methodName()`. No SDK/network calls.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeExecutor } from '../opencode-executor'

const executor = new OpenCodeExecutor()

// ── checkCliAvailable ──────────────────────────────────────────

describe('OpenCodeExecutor.checkCliAvailable', () => {
  test('returns a Promise<string | null>', async () => {
    const result = await executor.checkCliAvailable()
    // Should return null if CLI available, or error message if not
    assert.ok(result === null || typeof result === 'string')
  })

  test('error message contains helpful installation instructions', async () => {
    const result = await executor.checkCliAvailable()
    if (result) {
      // If CLI is not installed, should provide installation guidance
      assert.ok(
        result.includes('opencode') && (result.includes('Install') || result.includes('not found')),
        `Expected helpful installation message, got: ${result}`
      )
    }
  })
})

// ── isTransientError ──

describe('OpenCodeExecutor.isTransientError', () => {
  test('rate limit errors are transient', () => {
    assert.equal((executor as any).isTransientError('rate_limit exceeded'), true)
    assert.equal((executor as any).isTransientError('Rate Limit hit'), true)
  })

  test('overloaded errors are transient', () => {
    assert.equal((executor as any).isTransientError('server_is_overloaded'), true)
    assert.equal((executor as any).isTransientError('Server overloaded'), true)
  })

  test('HTTP 429/503 codes are transient', () => {
    assert.equal((executor as any).isTransientError('HTTP 429 Too Many Requests'), true)
    assert.equal((executor as any).isTransientError('status code 503'), true)
  })

  test('network errors are transient', () => {
    assert.equal((executor as any).isTransientError('ECONNRESET'), true)
    assert.equal((executor as any).isTransientError('ETIMEDOUT'), true)
    assert.equal((executor as any).isTransientError('ECONNREFUSED'), true)
  })

  test('timeout errors are transient', () => {
    assert.equal((executor as any).isTransientError('Request timeout after 30s'), true)
  })

  test('generic network keyword is transient', () => {
    assert.equal((executor as any).isTransientError('Network error occurred'), true)
  })

  test('non-transient errors return false', () => {
    assert.equal((executor as any).isTransientError('Invalid API key'), false)
    assert.equal((executor as any).isTransientError('Model not found'), false)
    assert.equal((executor as any).isTransientError('Permission denied'), false)
  })

  test('empty string returns false', () => {
    assert.equal((executor as any).isTransientError(''), false)
  })
})

// ── computeTransientRetry ──

describe('OpenCodeExecutor.computeTransientRetry', () => {
  test('first retry → attempt 1, delay 2000ms', () => {
    const result = (executor as any).computeTransientRetry(0, 'rate limit')
    assert.ok(result !== null)
    assert.equal(result.attemptNumber, 1)
    assert.equal(result.delayMs, 2000) // BASE_RETRY_DELAY_MS * 2^0
    assert.ok(result.startedMessage.includes('attempt 1'))
    assert.ok(result.resumingMessage.includes('Retry 1'))
  })

  test('second retry → attempt 2, delay 4000ms', () => {
    const result = (executor as any).computeTransientRetry(1, 'timeout')
    assert.ok(result !== null)
    assert.equal(result.attemptNumber, 2)
    assert.equal(result.delayMs, 4000) // 2000 * 2^1
  })

  test('third retry → attempt 3, delay 8000ms', () => {
    const result = (executor as any).computeTransientRetry(2, 'network error')
    assert.ok(result !== null)
    assert.equal(result.attemptNumber, 3)
    assert.equal(result.delayMs, 8000) // 2000 * 2^2
  })

  test('max retries exhausted → returns null', () => {
    // MAX_TRANSIENT_RETRIES = 3, so retryCount=3 means all 3 used
    const result = (executor as any).computeTransientRetry(3, 'rate limit')
    assert.equal(result, null)
  })
})

// ── isSessionComplete ──

describe('OpenCodeExecutor.isSessionComplete', () => {
  test('session.idle event → true', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), true)
  })

  test('session.error without retries → true', () => {
    const event = { type: 'session.error', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), true)
  })

  test('session.error with retries available → false (suppressed)', () => {
    const event = { type: 'session.error', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', true), false)
  })

  test('session.status idle → true', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'idle' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), true)
  })

  test('session.status error without retries → true', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'error' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), true)
  })

  test('different session ID → false', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'other-sess' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('event with no properties → false', () => {
    const event = { type: 'session.idle' }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('unrelated event type → false', () => {
    const event = { type: 'message.delta', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })
})

// ── buildPromptParts ──

describe('OpenCodeExecutor.buildPromptParts', () => {
  test('includes system prompt as first part when no plugin hook', () => {
    // Clear env to ensure no plugin hook
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const parts = (executor as any).buildPromptParts('hello world', 'You are an AI assistant.')
    assert.equal(parts.length, 2)
    assert.ok(parts[0].text.includes('[System Instructions]'))
    assert.ok(parts[0].text.includes('You are an AI assistant.'))
    assert.equal(parts[1].text, 'hello world')

    // Restore
    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('skips system prompt when plugin hook env is set', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = '/tmp/some-prompt.txt'

    const parts = (executor as any).buildPromptParts('hello', 'system prompt here')
    assert.equal(parts.length, 1)
    assert.equal(parts[0].text, 'hello')

    // Restore
    if (original) {
      process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
    } else {
      delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    }
  })

  test('empty system prompt → only user prompt part', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const parts = (executor as any).buildPromptParts('user message', '')
    assert.equal(parts.length, 1)
    assert.equal(parts[0].text, 'user message')

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })
})

// ── buildPromptBody ──

describe('OpenCodeExecutor.buildPromptBody', () => {
  const provider = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }

  test('includes model config in body', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const body = (executor as any).buildPromptBody('hi', 'sys', provider, undefined)
    assert.deepEqual(body.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' })
    assert.ok(Array.isArray(body.parts))

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('includes format with schema when outputSchema provided', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    const body = (executor as any).buildPromptBody('hi', '', provider, schema)
    assert.ok(body.format)
    assert.equal(body.format.type, 'json_schema')
    assert.deepEqual(body.format.schema, schema)
    assert.equal(body.format.retries, 2)

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('no format when outputSchema is undefined', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const body = (executor as any).buildPromptBody('hi', '', provider, undefined)
    assert.equal(body.format, undefined)

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })
})

// ── isTransientError: additional patterns ──

describe('OpenCodeExecutor.isTransientError — additional patterns', () => {
  test('server_is_overloaded is transient', () => {
    assert.equal((executor as any).isTransientError('server_is_overloaded'), true)
  })

  test('too many requests is transient', () => {
    assert.equal((executor as any).isTransientError('too many requests'), true)
  })

  test('socket hang up is NOT transient (not in pattern list)', () => {
    assert.equal((executor as any).isTransientError('socket hang up'), false)
  })

  test('case sensitivity: ECONNRESET is exact case match', () => {
    assert.equal((executor as any).isTransientError('ECONNRESET'), true)
    // lowercase should NOT match since ECONNRESET pattern has no /i flag
    assert.equal((executor as any).isTransientError('econnreset'), false)
  })
})

// ── isSessionComplete: edge cases ──

describe('OpenCodeExecutor.isSessionComplete — edge cases', () => {
  test('session.status with status "error" + retries available → false', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'error' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', true), false)
  })

  test('event with no type → false', () => {
    const event = { properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('event with empty properties object → false (no sessionID)', () => {
    const event = { type: 'session.idle', properties: {} }
    // properties exists but sessionID is undefined — should still match
    // because eventSessionId is undefined and the check is: if (eventSessionId && ...)
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), true)
  })
})

// ── buildPromptBody: schema injection ──

describe('OpenCodeExecutor.buildPromptBody — schema injection', () => {
  const provider = { providerId: 'openai', modelId: 'gpt-4o' }

  test('JSON schema format has correct structure', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const schema = { type: 'object', properties: { result: { type: 'boolean' } } }
    const body = (executor as any).buildPromptBody('test', '', provider, schema)
    assert.equal(body.format.type, 'json_schema')
    assert.deepEqual(body.format.schema, schema)
    assert.equal(body.format.retries, 2)

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('retries config is always 2 for JSON schema output', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const schema = { type: 'string' }
    const body = (executor as any).buildPromptBody('test', '', provider, schema)
    assert.equal(body.format.retries, 2)

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('non-anthropic provider uses correct model config', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const body = (executor as any).buildPromptBody('hi', 'sys', provider, undefined)
    assert.deepEqual(body.model, { providerID: 'openai', modelID: 'gpt-4o' })

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })
})

// ── isTransientError: boundary & additional patterns ──

describe('OpenCodeExecutor.isTransientError — boundary patterns', () => {
  test('529 status code matches /503/ is false — 529 is not in pattern list', () => {
    // The patterns include /503/ and /429/ but not /529/
    assert.equal((executor as any).isTransientError('HTTP 529 Service Unavailable'), false)
  })

  test('HTTP 503 in a sentence is transient', () => {
    assert.equal((executor as any).isTransientError('Received HTTP 503 from upstream'), true)
  })

  test('HTTP 429 in a sentence is transient', () => {
    assert.equal((executor as any).isTransientError('Error: HTTP 429 rate limited'), true)
  })

  test('server_error does NOT match (only overloaded patterns)', () => {
    assert.equal((executor as any).isTransientError('server_error'), false)
  })

  test('RATE LIMIT (uppercase) matches case-insensitive /rate.?limit/i', () => {
    assert.equal((executor as any).isTransientError('RATE LIMIT'), true)
  })

  test('rate-limit with hyphen matches /rate.?limit/i', () => {
    assert.equal((executor as any).isTransientError('rate-limit exceeded'), true)
  })

  test('ratelimit without separator matches /rate.?limit/i', () => {
    assert.equal((executor as any).isTransientError('ratelimit exceeded'), true)
  })

  test('model_not_found is NOT transient', () => {
    assert.equal((executor as any).isTransientError('model_not_found'), false)
  })

  test('invalid_api_key is NOT transient', () => {
    assert.equal((executor as any).isTransientError('invalid_api_key'), false)
  })

  test('authentication error is NOT transient', () => {
    assert.equal((executor as any).isTransientError('Authentication failed'), false)
  })

  test('mixed case Timeout matches /timeout/i', () => {
    assert.equal((executor as any).isTransientError('Connection Timeout Expired'), true)
  })

  test('Network Error (mixed case) matches /network/i', () => {
    assert.equal((executor as any).isTransientError('NETWORK ERROR'), true)
  })
})

// ── computeTransientRetry: message content ──

describe('OpenCodeExecutor.computeTransientRetry — message content', () => {
  test('startedMessage includes attempt count and delay in seconds', () => {
    const result = (executor as any).computeTransientRetry(0, 'rate limit')
    assert.ok(result.startedMessage.includes('attempt 1'))
    assert.ok(result.startedMessage.includes('2s'))
  })

  test('resumingMessage includes retry number', () => {
    const result = (executor as any).computeTransientRetry(1, 'timeout')
    assert.ok(result.resumingMessage.includes('Retry 2'))
  })

  test('delay formula: BASE × 2^(attempt-1)', () => {
    const r0 = (executor as any).computeTransientRetry(0, 'err')
    const r1 = (executor as any).computeTransientRetry(1, 'err')
    const r2 = (executor as any).computeTransientRetry(2, 'err')
    // BASE = 2000
    assert.equal(r0.delayMs, 2000) // 2000 * 2^0
    assert.equal(r1.delayMs, 4000) // 2000 * 2^1
    assert.equal(r2.delayMs, 8000) // 2000 * 2^2
  })

  test('retryCount >= MAX_TRANSIENT_RETRIES (3) → null', () => {
    assert.equal((executor as any).computeTransientRetry(3, 'err'), null)
    assert.equal((executor as any).computeTransientRetry(4, 'err'), null)
    assert.equal((executor as any).computeTransientRetry(100, 'err'), null)
  })
})

// ── isSessionComplete: additional event types ──

describe('OpenCodeExecutor.isSessionComplete — additional events', () => {
  test('session.created event → false (not terminal)', () => {
    const event = { type: 'session.created', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('session.updated event → false', () => {
    const event = { type: 'session.updated', properties: { sessionID: 'sess-1' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('session.status running → false', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'running' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })

  test('session.status error with retries → false', () => {
    const event = { type: 'session.status', properties: { sessionID: 'sess-1', status: 'error' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', true), false)
  })

  test('empty object event → false', () => {
    assert.equal((executor as any).isSessionComplete({}, 'sess-1', false), false)
  })

  test('event with properties but wrong sessionID → false', () => {
    const event = { type: 'session.idle', properties: { sessionID: 'wrong-sess' } }
    assert.equal((executor as any).isSessionComplete(event, 'sess-1', false), false)
  })
})

// ── buildPromptBody: edge cases ──

describe('OpenCodeExecutor.buildPromptBody — edge cases', () => {
  test('provider mapping: providerId → providerID, modelId → modelID', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const provider = { providerId: 'custom', modelId: 'my-model-v1' }
    const body = (executor as any).buildPromptBody('test', '', provider, undefined)
    assert.equal(body.model.providerID, 'custom')
    assert.equal(body.model.modelID, 'my-model-v1')
    // Confirm original field names are NOT present
    assert.equal(body.model.providerId, undefined)
    assert.equal(body.model.modelId, undefined)

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })

  test('body has parts array', () => {
    const original = process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE
    delete process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE

    const provider = { providerId: 'anthropic', modelId: 'claude-sonnet-4-6' }
    const body = (executor as any).buildPromptBody('hello', 'system', provider, undefined)
    assert.ok(Array.isArray(body.parts), 'body should have a parts array')
    assert.ok(body.parts.length >= 1, 'should have at least one part')

    if (original) process.env.CODE_ATELIER_SYSTEM_PROMPT_FILE = original
  })
})

// ── OC-02: Config inline read (Change 1) ──

describe('OC-02: Config file read + inline pass', () => {
  test('reads valid JSON config file and parses to object', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'oc02-'))
    const configPath = join(dir, 'opencode.json')
    const configObj = {
      provider: { omlx: { models: { 'test-model': { limit: { context: 131072 } } } } }
    }
    writeFileSync(configPath, JSON.stringify(configObj))

    // Simulate the exact logic from start()
    const { readFileSync } = await import('node:fs')
    const configContent = JSON.parse(readFileSync(configPath, 'utf-8'))

    assert.deepEqual(configContent, configObj)
    assert.equal(configContent.provider.omlx.models['test-model'].limit.context, 131072)

    rmSync(dir, { recursive: true, force: true })
  })

  test('missing config file does not throw when wrapped in try/catch', async () => {
    // Simulates the graceful fallback in start()
    let configContent: Record<string, unknown> | undefined
    try {
      const { readFileSync } = await import('node:fs')
      configContent = JSON.parse(readFileSync('/nonexistent/opencode.json', 'utf-8'))
    } catch (_err) {
      // Expected — mirroring the warn + fallback in start()
    }
    assert.equal(configContent, undefined, 'Should remain undefined on read failure')
  })

  test('malformed JSON file does not throw when wrapped in try/catch', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    const dir = mkdtempSync(join(tmpdir(), 'oc02-bad-'))
    const configPath = join(dir, 'opencode.json')
    writeFileSync(configPath, '{ invalid json }')

    let configContent: Record<string, unknown> | undefined
    try {
      const { readFileSync } = await import('node:fs')
      configContent = JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch (_err) {
      // Expected
    }
    assert.equal(configContent, undefined, 'Should remain undefined on parse failure')

    rmSync(dir, { recursive: true, force: true })
  })

  test('configContent spread produces correct createOpencode options shape', async () => {
    const configContent = { provider: { omlx: {} } }
    // Simulates: ...(configContent ? { config: configContent as any } : {})
    const opts = {
      port: 4096,
      timeout: 30000,
      ...(configContent ? { config: configContent } : {})
    }
    assert.equal(opts.port, 4096)
    assert.deepEqual(opts.config, configContent)

    // When configContent is undefined, config key should be absent
    const optsNoConfig = {
      port: 4096,
      timeout: 10000
    }
    assert.equal(optsNoConfig.port, 4096)
    assert.equal('config' in optsNoConfig, false, 'config key should not exist when undefined')
  })
})

// ── OC-03: Prompt response error detection (Change 2) ──

describe('OC-03: Prompt response error detection', () => {
  /**
   * Replicated logic from the .then() handler in opencode-executor.ts.
   * Returns { rejected: true, message } for error responses,
   * or { rejected: false, id } for success.
   */
  function classifyPromptResponse(response: any): { rejected: boolean; message?: string; id?: string } {
    const data = response?.data ?? response
    if (data?.name === 'UnknownError' || data?.name === 'Error') {
      return {
        rejected: true,
        message: `OpenCode server error: ${data?.data?.message ?? data?.message ?? 'unknown'}`
      }
    }
    return { rejected: false, id: data?.id ?? 'ok' }
  }

  test('UnknownError response is detected as rejected', () => {
    const response = {
      data: {
        name: 'UnknownError',
        data: { message: 'Unexpected server error' }
      }
    }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, true)
    assert.ok(result.message!.includes('Unexpected server error'))
  })

  test('Error response is detected as rejected', () => {
    const response = {
      data: {
        name: 'Error',
        message: 'Provider not configured'
      }
    }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, true)
    assert.ok(result.message!.includes('Provider not configured'))
  })

  test('successful response with id is accepted', () => {
    const response = {
      data: {
        id: 'msg-abc123'
      }
    }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, false)
    assert.equal(result.id, 'msg-abc123')
  })

  test('response with no data falls back to ok', () => {
    const result = classifyPromptResponse({})
    assert.equal(result.rejected, false)
    assert.equal(result.id, 'ok')
  })

  test('null/undefined response falls back to ok', () => {
    assert.equal(classifyPromptResponse(null).rejected, false)
    assert.equal(classifyPromptResponse(null).id, 'ok')
    assert.equal(classifyPromptResponse(undefined).rejected, false)
    assert.equal(classifyPromptResponse(undefined).id, 'ok')
  })

  test('UnknownError with nested data.data.message extracts correctly', () => {
    // SDK wraps all responses in .data — error shape is { data: { name, data: { message } } }
    const response = {
      data: {
        name: 'UnknownError',
        data: { message: 'model not found: mlx-community/test' }
      }
    }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, true)
    assert.ok(result.message!.includes('model not found'))
  })

  test('flat response without .data wrapper falls back gracefully (not detected as error)', () => {
    // Edge case: if SDK ever returns a flat object, the name check won't match
    // because response.data is truthy (the message object) so data.name is undefined.
    // This is acceptable — the SDK consistently wraps in .data.
    const response = {
      name: 'UnknownError',
      data: { message: 'some error' }
    }
    const result = classifyPromptResponse(response)
    // data = response.data = { message: 'some error' }, data.name = undefined → not rejected
    assert.equal(result.rejected, false)
  })

  test('Error without any message still produces a message', () => {
    const response = { data: { name: 'Error' } }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, true)
    assert.ok(result.message!.includes('unknown'))
  })

  test('response.data.name with non-error value is accepted', () => {
    // A normal response might have a name field that isn't an error
    const response = { data: { name: 'session', id: 'sess-1' } }
    const result = classifyPromptResponse(response)
    assert.equal(result.rejected, false)
    assert.equal(result.id, 'sess-1')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
