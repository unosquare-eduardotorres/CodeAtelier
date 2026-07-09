/**
 * Integration test for OpenCodeExecutor.processEventStream() with synthetic SSE.
 *
 * Feeds fake events into the real event processing pipeline to verify:
 * - Error objects are coerced to strings (the fixed bug)
 * - Session completion is detected correctly (idle terminates the loop)
 * - Text parts accumulate into resultText
 *
 * Accesses the private `processEventStream` method via prototype cast —
 * same pattern as chat-stream-lifecycle.test.ts.
 *
 * Run: npx tsx src/main/services/__tests__/opencode-executor-event-stream.test.ts
 * NOT registered in run-tests.ts — accesses private methods.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeExecutor } from '../opencode-executor'
import type { StreamChunk } from '../agent-base.service'

const SID = 'synthetic-session-1'

// ── Synthetic event helpers ──

function textPartEvent(content: string) {
  return {
    type: 'message.part.updated',
    properties: { part: { type: 'text', content } }
  }
}

function sessionErrorEvent(error: unknown) {
  return { type: 'session.error', properties: { error } }
}

function sessionIdleEvent() {
  return { type: 'session.idle', properties: {} }
}

/** Create an async iterable from an array of events */
async function* fakeStream(events: unknown[]): AsyncIterable<unknown> {
  for (const e of events) yield e
}

// ── Access private method via prototype cast ──

async function collectChunks(
  executor: OpenCodeExecutor,
  events: unknown[]
): Promise<Array<StreamChunk>> {
  const proto = OpenCodeExecutor.prototype as unknown as Record<string, Function>
  const processEventStream = proto.processEventStream.bind(executor)

  const gen = processEventStream({
    events: { stream: fakeStream(events) },
    openCodeSessionId: SID,
    promptBody: { parts: [{ type: 'text', text: 'test' }] },
    tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    maxTurns: 0
  })

  const chunks: StreamChunk[] = []
  let result = await gen.next()
  while (!result.done) {
    chunks.push(result.value as StreamChunk)
    result = await gen.next()
  }
  return chunks
}

// ── Tests ──

describe('processEventStream — synthetic SSE integration', () => {
  test('happy path: text → idle produces text chunk then completes', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      textPartEvent('Hello world'),
      sessionIdleEvent()
    ])

    const textChunks = chunks.filter((c) => c.type === 'text')
    assert.ok(textChunks.length >= 1, 'Should emit at least one text chunk')
    assert.equal(textChunks[0].content, 'Hello world')
  })

  test('SDK error object is coerced and emitted as error chunk', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ name: 'UnknownError', data: { message: 'model not found' } })
    ])

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Should emit at least one error chunk')
    assert.equal(typeof errorChunks[0].error, 'string', 'Error should be a string')
    assert.equal(errorChunks[0].error, 'model not found')
  })

  test('transient SDK error object triggers api_retry chunk', async () => {
    const executor = new OpenCodeExecutor()
    // 'overloaded' is classified as transient by the normalizer →
    // emits api_retry chunk (not error), so processEventStream receives it as api_retry.
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ name: 'ApiError', data: { message: 'server overloaded' } }),
      sessionIdleEvent()
    ])

    const retryChunks = chunks.filter(
      (c) => c.type === 'api_retry' || c.type === 'session_recovery'
    )
    assert.ok(retryChunks.length >= 1, 'Should trigger retry/recovery for transient error')
  })

  test('opaque error object survives via JSON.stringify', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ code: 42, detail: 'unknown' })
    ])

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Should emit error chunk for opaque error')
    assert.equal(
      typeof errorChunks[0].error,
      'string',
      `Error should be a string, got ${typeof errorChunks[0].error}`
    )
    // JSON.stringify fallback should produce a parseable string
    assert.ok(errorChunks[0].error!.includes('42'), 'Should contain stringified code')
  })

  test('session.idle terminates the stream loop', async () => {
    const executor = new OpenCodeExecutor()
    // Events after idle should be ignored
    const chunks = await collectChunks(executor, [
      textPartEvent('before idle'),
      sessionIdleEvent(),
      textPartEvent('after idle — should not appear')
    ])

    const textChunks = chunks.filter((c) => c.type === 'text')
    assert.equal(textChunks.length, 1, 'Only text before idle should appear')
    assert.equal(textChunks[0].content, 'before idle')
  })

  test('string error still works (regression guard)', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      sessionErrorEvent('plain string error')
    ])

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Should emit error chunk for string error')
    assert.equal(errorChunks[0].error, 'plain string error')
  })

  test('non-transient error does not deadlock when no retry fires', async () => {
    const executor = new OpenCodeExecutor()
    // Before the fix: session.error was suppressed because
    // transientRetryCount (0) < MAX_TRANSIENT_RETRIES (3) → retriesAvailable=true
    // but no retry ever fired → stream hung forever.
    // After the fix: retryInitiatedThisEvent is false → session terminates.
    const deadline = Date.now() + 5000
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ name: 'ProviderError', data: { message: 'invalid model' } })
      // No sessionIdleEvent — session.error IS the last event
    ])

    assert.ok(Date.now() < deadline, 'DEADLOCK: stream hung on non-transient error')
    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Should emit error chunk and terminate')
    assert.equal(errorChunks[0].error, 'invalid model')
  })

  test('transient error does not deadlock when normalizer classifies as api_retry', async () => {
    const executor = new OpenCodeExecutor()
    // 'overloaded' → normalizer emits api_retry chunk (not error chunk).
    // The error chunk path in processEventStream is never entered, so
    // retryInitiatedThisEvent stays false. session.error must still terminate.
    // Before fix: suppressed → hang. After fix: terminates.
    const deadline = Date.now() + 5000
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ name: 'ApiError', data: { message: 'server overloaded' } })
      // No sessionIdleEvent — session.error IS the last event
    ])

    assert.ok(Date.now() < deadline, 'DEADLOCK: stream hung on normalizer-classified transient error')
    assert.ok(chunks.length >= 1, 'Should produce chunks and terminate')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
