/**
 * Pipeline test: normalizer → stream processor.
 * Verifies SDK error objects survive the full chunk pipeline without crash.
 *
 * This is the exact path that caused "error.includes is not a function":
 *   SDK SSE event → normalizeOpenCodeEvent() → StreamChunk → processContentChunk()
 *
 * Run: npx tsx src/main/services/__tests__/opencode-error-pipeline.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, createSpy } from './test-harness'
import {
  normalizeOpenCodeEvent,
  type ExecutorTokenUsage,
  type NormalizerState
} from '../opencode-event-normalizer'
import { AgentStreamProcessor } from '../agent-stream-processor'

// ── Helpers ──

function freshState(): NormalizerState {
  return { childSessions: new Map(), sessionMap: new Map() }
}

function freshUsage(): ExecutorTokenUsage {
  return { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
}

function makeHost(over: Record<string, unknown> = {}) {
  const noop = () => {}
  return {
    emit: createSpy(),
    log: { info: noop, warn: noop, debug: noop, error: noop },
    compactAutoThreshold: 800,
    compactSuggestThreshold: 500,
    llmProvider: 'opencode',
    compactSuggested: false,
    turnsSinceCompactSuggestion: 0,
    accumulatedText: '',
    currentStatus: 'writing',
    getStatus: () => ({ status: 'writing' }),
    clearSession: createSpy(),
    ...over
  }
}

const SID = 'session-pipeline-test'

/**
 * Run a full pipeline: SDK event → normalizer → processor.
 * Returns { chunks, results, host } for assertions.
 */
function runPipeline(
  event: Record<string, unknown>,
  hostOverrides?: Record<string, unknown>
) {
  // Step 1: Normalize (what opencode-executor.ts does)
  const chunks = normalizeOpenCodeEvent(event, SID, freshUsage(), freshState())

  // Step 2: Process each chunk (what agent-session.service.ts does)
  const host = makeHost(hostOverrides)
  const proc = new AgentStreamProcessor(host)
  const results = chunks.map((chunk) =>
    proc.processContentChunk(chunk as never, {
      conversationId: 'conv-pipeline',
      isBuildMode: true,
      streamState: {} as never
    })
  )

  return { chunks, results, host }
}

// ── Tests ──

describe('Error pipeline: SDK event → normalizer → stream processor', () => {
  test('SDK UnknownError object flows through full pipeline without crash', () => {
    const { chunks, results } = runPipeline({
      type: 'session.error',
      properties: {
        error: { name: 'UnknownError', data: { message: 'model not found' } }
      }
    })
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].type, 'error')
    assert.equal(chunks[0].error, 'model not found')
    assert.equal(results[0], 'next') // no crash, no special handling
  })

  test('SDK error with session-recovery message triggers recovery break', () => {
    const host = makeHost()
    const proc = new AgentStreamProcessor(host)
    const streamState = {} as { sessionRecoveryNeeded?: boolean }

    const chunks = normalizeOpenCodeEvent(
      {
        type: 'session.error',
        properties: {
          error: {
            name: 'ProviderAuthError',
            data: { message: 'No conversation found with session ID abc' }
          }
        }
      },
      SID,
      freshUsage(),
      freshState()
    )
    assert.equal(chunks[0].error, 'No conversation found with session ID abc')

    const result = proc.processContentChunk(chunks[0] as never, {
      conversationId: 'conv-recovery',
      isBuildMode: true,
      streamState: streamState as never
    })
    assert.equal(result, 'break')
    assert.equal(streamState.sessionRecoveryNeeded, true)
  })

  test('SDK transient error object triggers api_retry classification', () => {
    const { chunks } = runPipeline({
      type: 'session.error',
      properties: {
        error: { name: 'ApiError', data: { message: 'server overloaded' } }
      }
    })
    assert.equal(chunks[0].type, 'api_retry')
    assert.ok(chunks[0].content!.includes('server overloaded'))
  })

  test('SDK budget cap error object triggers budget break in processor', () => {
    const { chunks, results, host } = runPipeline({
      type: 'session.error',
      properties: {
        error: { name: 'ApiError', data: { message: 'budget cap exceeded for session' } }
      }
    })
    assert.equal(chunks[0].type, 'error')
    assert.equal(chunks[0].error, 'budget cap exceeded for session')
    assert.equal(results[0], 'break')
    assert.ok(
      (host.emit as ReturnType<typeof createSpy>).calls.some(
        (c: unknown[]) => c[0] === 'budgetCapReached'
      )
    )
  })

  test('opaque error object (no .data.message) survives pipeline via JSON.stringify', () => {
    const { chunks, results } = runPipeline({
      type: 'session.error',
      properties: {
        error: { code: 'INTERNAL', status: 500 }
      }
    })
    assert.equal(chunks[0].type, 'error')
    assert.ok(chunks[0].error!.includes('INTERNAL'))
    assert.ok(chunks[0].error!.includes('500'))
    assert.equal(results[0], 'next')
  })

  test('string error still works end-to-end (regression)', () => {
    const { chunks, results } = runPipeline({
      type: 'session.error',
      properties: { error: 'plain old string error' }
    })
    assert.equal(chunks[0].error, 'plain old string error')
    assert.equal(results[0], 'next')
  })

  test('non-transient error terminates session via processEventStream (no deadlock)', async () => {
    // Before the fix, isSessionComplete suppressed session.error when
    // transientRetryCount < MAX_RETRIES (always true when 0) → infinite hang.
    // After the fix, retriesAvailable is only true when a retry was actually
    // initiated for the current event.
    const { OpenCodeExecutor } = await import('../opencode-executor')
    type StreamChunk = import('../agent-base.service').StreamChunk

    const executor = new OpenCodeExecutor()
    const proto = OpenCodeExecutor.prototype as unknown as Record<string, Function>
    const processEventStream = proto.processEventStream.bind(executor)

    async function* fakeStream(events: unknown[]): AsyncIterable<unknown> {
      for (const e of events) yield e
    }

    const gen = processEventStream({
      events: { stream: fakeStream([
        { type: 'session.error', properties: { error: { name: 'ProviderError', data: { message: 'invalid model' } } } }
      ]) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0
    })

    const deadline = Date.now() + 5000
    const chunks: StreamChunk[] = []
    let result = await gen.next()
    while (!result.done) {
      chunks.push(result.value as StreamChunk)
      assert.ok(Date.now() < deadline, 'DEADLOCK: processEventStream hung on non-transient error')
      result = await gen.next()
    }

    const errorChunks = chunks.filter((c: StreamChunk) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Should emit error chunk and terminate')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
