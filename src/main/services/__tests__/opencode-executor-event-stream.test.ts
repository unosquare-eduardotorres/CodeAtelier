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

/** An async iterable that yields the given events, then never resolves (simulates an SSE stall). */
function stallingStream(events: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (i < events.length) return Promise.resolve({ done: false, value: events[i++] })
          return new Promise(() => {}) // hang forever — the stall
        }
      }
    }
  }
}

// ── Access private method via prototype cast ──

interface StreamRunResult {
  resultText: string
  maxTurnsReached: boolean
  transientRetries: number
  lastTransientClass: 'slow' | 'fast' | null
  endedWithTerminalError: boolean
}

async function runEventStream(
  executor: OpenCodeExecutor,
  events: unknown[],
  opts: {
    midTurnStallMs?: number
    stream?: AsyncIterable<unknown>
  } = {}
): Promise<{ chunks: StreamChunk[]; result: StreamRunResult }> {
  const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
  const processEventStream = proto.processEventStream.bind(executor)
  // Shrink real backoff sleeps (30s/2s → 30ms/2ms) so transient-retry tests
  // stay fast. Reported retryInfo delays are NOT scaled.
  shrinkRetryDelays(executor)

  const gen = processEventStream({
    events: { stream: opts.stream ?? fakeStream(events) },
    openCodeSessionId: SID,
    promptBody: { parts: [{ type: 'text', text: 'test' }] },
    tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    maxTurns: 0,
    ...(opts.midTurnStallMs !== undefined ? { midTurnStallMs: opts.midTurnStallMs } : {})
  })

  const chunks: StreamChunk[] = []
  let result = await gen.next()
  while (!result.done) {
    chunks.push(result.value as StreamChunk)
    result = await gen.next()
  }
  return { chunks, result: result.value as StreamRunResult }
}

async function collectChunks(
  executor: OpenCodeExecutor,
  events: unknown[]
): Promise<Array<StreamChunk>> {
  return (await runEventStream(executor, events)).chunks
}

/** Shrink real retry backoff sleeps (30s → 30ms) without touching reported retryInfo. */
function shrinkRetryDelays(executor: OpenCodeExecutor): void {
  ;(executor as unknown as { retryDelayScale: number }).retryDelayScale = 0.001
}

/** Minimal fake client capturing promptAsync (resend) + abort calls. */
function fakeClient(): {
  client: { session: { promptAsync: () => Promise<void>; abort: () => Promise<void> } }
  prompts: number
  aborts: number
} {
  const calls = { prompts: 0, aborts: 0 }
  return {
    client: {
      session: {
        promptAsync: () => {
          calls.prompts++
          return Promise.resolve()
        },
        abort: () => {
          calls.aborts++
          return Promise.resolve()
        }
      }
    },
    get prompts() {
      return calls.prompts
    },
    get aborts() {
      return calls.aborts
    }
  }
}

/**
 * PARITY FIX (E) test helper: fake client whose event.subscribe() hands out
 * successive streams from a queue and counts subscriptions. Also captures
 * promptAsync/abort and answers session.messages with an empty list.
 */
function resubscribingClient(streams: AsyncIterable<unknown>[]): {
  client: Record<string, unknown>
  subscribes: number
  prompts: number
  aborts: number
} {
  const calls = { subscribes: 0, prompts: 0, aborts: 0 }
  const queue = [...streams]
  return {
    client: {
      event: {
        subscribe: () => {
          calls.subscribes++
          const next = queue.shift()
          if (!next) throw new Error('test: no more streams in subscribe queue')
          return Promise.resolve({ stream: next })
        }
      },
      session: {
        create: () => Promise.resolve({ data: { id: SID } }),
        promptAsync: () => {
          calls.prompts++
          return Promise.resolve()
        },
        abort: () => {
          calls.aborts++
          return Promise.resolve()
        },
        messages: () => Promise.resolve({ data: [] })
      }
    },
    get subscribes() {
      return calls.subscribes
    },
    get prompts() {
      return calls.prompts
    },
    get aborts() {
      return calls.aborts
    }
  }
}

// ── Tests ──

describe('processEventStream — synthetic SSE integration', () => {
  test('happy path: text → idle produces text chunk then completes', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [textPartEvent('Hello world'), sessionIdleEvent()])

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
    const chunks = await collectChunks(executor, [sessionErrorEvent('plain string error')])

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
    // SSE-RETRY FIX (A): the api_retry chunk now triggers handleTransientRetry
    // (retryInitiatedThisEvent=true → session.error suppressed), the stream
    // ends, and the loop terminates via iterator completion.
    const deadline = Date.now() + 5000
    const chunks = await collectChunks(executor, [
      sessionErrorEvent({ name: 'ApiError', data: { message: 'server overloaded' } })
      // No sessionIdleEvent — session.error IS the last event
    ])

    assert.ok(
      Date.now() < deadline,
      'DEADLOCK: stream hung on normalizer-classified transient error'
    )
    assert.ok(chunks.length >= 1, 'Should produce chunks and terminate')
  })
})

describe('processEventStream — SSE-RETRY FIX (A): api_retry interception', () => {
  test('transient session.error → session_recovery chunks + corrected retryInfo + prompt re-sent', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    const { chunks, result } = await runEventStream(executor, [
      sessionErrorEvent({ name: 'ApiError', data: { message: 'SSE read timed out' } }),
      sessionIdleEvent()
    ])

    // api_retry forwarded with REAL retryInfo (slow class → 30000ms, not the
    // normalizer's hardcoded 1/3/2000)
    const apiRetry = chunks.find((c) => c.type === 'api_retry')
    assert.ok(apiRetry, 'api_retry chunk should be forwarded')
    assert.equal(apiRetry!.retryInfo?.attempt, 1)
    assert.equal(apiRetry!.retryInfo?.maxRetries, 3)
    assert.equal(apiRetry!.retryInfo?.retryDelayMs, 30_000, 'slow class must report 30s backoff')

    // session_recovery lifecycle chunks
    const phases = chunks
      .filter((c) => c.type === 'session_recovery')
      .map((c) => c.recoveryPhase)
    assert.ok(phases.includes('started'), 'session_recovery started missing')
    assert.ok(phases.includes('resuming'), 'session_recovery resuming missing')

    // prompt re-sent via promptAsync
    assert.equal(fake.prompts, 1, 'retry must re-send the prompt')

    // loop did NOT terminate on the error — it completed via idle
    assert.equal(result.transientRetries, 1)
    assert.equal(result.lastTransientClass, 'slow')
  })

  test('fast-class transient (overloaded) reports 2000ms retryInfo', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    const { chunks, result } = await runEventStream(executor, [
      sessionErrorEvent({ name: 'ApiError', data: { message: 'server overloaded' } }),
      sessionIdleEvent()
    ])

    const apiRetry = chunks.find((c) => c.type === 'api_retry')
    assert.ok(apiRetry)
    assert.equal(apiRetry!.retryInfo?.retryDelayMs, 2_000, 'fast class must report 2s backoff')
    assert.equal(result.lastTransientClass, 'fast')
  })

  test('api_retry exhaustion → terminal error chunk (not truncated-completed)', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // 4 transient errors: 3 retries fire, the 4th exhausts the budget
    const err = () => sessionErrorEvent({ name: 'ApiError', data: { message: 'SSE read timed out' } })
    const { chunks, result } = await runEventStream(executor, [err(), err(), err(), err()])

    assert.equal(fake.prompts, 3, 'exactly 3 retries must fire')
    const recoveryChunks = chunks.filter((c) => c.type === 'session_recovery')
    assert.equal(recoveryChunks.length, 6, '3 retries × (started + resuming)')

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'exhaustion must yield a terminal error chunk')
    assert.match(errorChunks[errorChunks.length - 1].error ?? '', /timed out/)
    assert.equal(result.transientRetries, 3)
  })

  test('string transient error (ETIMEDOUT) also triggers the retry path', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // String errors go through the same normalizer classification → api_retry
    const { chunks } = await runEventStream(executor, [
      sessionErrorEvent('connect ETIMEDOUT 1.2.3.4:443'),
      sessionIdleEvent()
    ])

    const hasRecovery = chunks.some((c) => c.type === 'session_recovery')
    assert.ok(hasRecovery, 'string transient error must trigger recovery')
    assert.equal(fake.prompts, 1)
  })
})

describe('processEventStream — MID-TURN STALL FIX (B)', () => {
  test('activity then silence → abort + slow-class retry + recovery chunks', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Controllable stream: emits one activity event, then hangs on a gate the
    // test releases after asserting the stall fired.
    let activitySent = false
    let released = false
    let releasedEvent: unknown = null
    const manual: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (!activitySent) {
              activitySent = true
              return Promise.resolve({ done: false, value: textPartEvent('working on it') })
            }
            if (released) {
              return releasedEvent
                ? Promise.resolve({ done: false, value: releasedEvent })
                : Promise.resolve({ done: true, value: undefined })
            }
            return new Promise<IteratorResult<unknown>>((resolve) => {
              const poll = setInterval(() => {
                if (released) {
                  clearInterval(poll)
                  resolve(
                    releasedEvent
                      ? { done: false, value: releasedEvent }
                      : { done: true, value: undefined }
                  )
                }
              }, 10)
            })
          }
        }
      }
    }

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: manual },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      midTurnStallMs: 60
    })

    const chunks: StreamChunk[] = []
    const consumer = (async () => {
      let r = await gen.next()
      while (!r.done) {
        chunks.push(r.value as StreamChunk)
        r = await gen.next()
      }
      return r.value as StreamRunResult
    })()

    // Wait for the stall (60ms) + scaled retry backoff to fire, then release
    // IMMEDIATELY so the re-armed 60ms stall window doesn't fire a second retry.
    const releaseDeadline = Date.now() + 2000
    while (fake.prompts < 1 && Date.now() < releaseDeadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(fake.aborts, 1, 'zombie prompt must be aborted on stall')
    assert.equal(fake.prompts, 1, 'prompt must be re-sent after stall retry')
    const phases = chunks
      .filter((c) => c.type === 'session_recovery')
      .map((c) => c.recoveryPhase)
    assert.ok(phases.includes('started'), 'stall retry must emit session_recovery started')
    assert.ok(phases.includes('resuming'), 'stall retry must emit session_recovery resuming')

    // Release the stream — idle terminates the turn
    released = true
    releasedEvent = sessionIdleEvent()
    const result = await consumer

    assert.equal(result.transientRetries, 1)
    assert.equal(result.lastTransientClass, 'slow')
  })

  test('repeated stalls exhaust the 3-retry budget → terminal error', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Stream that emits one activity event then hangs forever
    const hanging = stallingStream([textPartEvent('starting')])

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: hanging },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      midTurnStallMs: 40
    })

    const chunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    assert.equal(fake.aborts, 4, 'each stall firing aborts the zombie prompt (3 retries + 1 exhausted)')
    assert.equal(fake.prompts, 3)
    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'exhausted stalls must yield a terminal error')
    assert.match(errorChunks[errorChunks.length - 1].error ?? '', /stalled/)
    assert.equal((r.value as StreamRunResult).transientRetries, 3)
  })

  test('steady activity never fires the stall watcher', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Events arrive every 30ms with a 100ms stall window — no stall should fire
    const events = [
      textPartEvent('a'),
      textPartEvent('b'),
      textPartEvent('c'),
      sessionIdleEvent()
    ]
    const slowStream = {
      [Symbol.asyncIterator]() {
        let i = 0
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (i < events.length) {
              await new Promise((res) => setTimeout(res, 30))
              return { done: false, value: events[i++] }
            }
            return { done: true, value: undefined }
          }
        }
      }
    }

    const { chunks, result } = await runEventStream(executor, [], {
      midTurnStallMs: 100,
      stream: slowStream
    })

    assert.equal(fake.aborts, 0, 'no stall should fire for steady activity')
    assert.equal(result.transientRetries, 0)
    assert.ok(chunks.some((c) => c.type === 'text' && c.content === 'a'))
  })
})

describe('processEventStream — SSE-RETRY FIX (D): retry telemetry', () => {
  test('clean turn reports transientRetries=0 and null class', async () => {
    const executor = new OpenCodeExecutor()
    const { result } = await runEventStream(executor, [
      textPartEvent('all good'),
      sessionIdleEvent()
    ])
    assert.equal(result.transientRetries, 0)
    assert.equal(result.lastTransientClass, null)
  })
})

describe('processEventStream — PARITY FIX (E): SSE re-subscribe after retry resend', () => {
  test('stream ends after retry → re-subscribe → resent run observed and completes', async () => {
    const executor = new OpenCodeExecutor()
    const fake = resubscribingClient([
      // stream 2 (the re-subscription): the resent prompt's run
      fakeStream([textPartEvent('recovered answer'), sessionIdleEvent()])
    ])
    ;(executor as unknown as { client: unknown }).client = fake.client

    // stream 1 (initial): activity, then a transient error, then the server
    // closes the subscription (done) — the T002/T004 failure shape.
    const { chunks, result } = await runEventStream(executor, [], {
      stream: fakeStream([
        textPartEvent('first attempt partial'),
        sessionErrorEvent({ name: 'ApiError', data: { message: 'SSE read timed out' } })
      ])
    })

    // Re-subscribed exactly once
    assert.equal(fake.subscribes, 1, 'must re-subscribe after the post-retry stream end')
    // The resent prompt was re-sent exactly once
    assert.equal(fake.prompts, 1)
    // The resent run's text was observed (not a truncated-but-completed turn)
    assert.ok(
      chunks.some((c) => c.type === 'text' && c.content === 'recovered answer'),
      'resent run text must be observed after re-subscribe'
    )
    assert.equal(result.transientRetries, 1)
    assert.equal(result.lastTransientClass, 'slow')
    assert.equal(result.endedWithTerminalError, false)
    // Recovery lifecycle chunks surfaced
    const phases = chunks
      .filter((c) => c.type === 'session_recovery')
      .map((c) => c.recoveryPhase)
    assert.ok(phases.includes('started'))
    assert.ok(phases.includes('resuming'))
  })

  test('three error→done cycles → 3 retries → terminal error, no 4th re-subscribe', async () => {
    const executor = new OpenCodeExecutor()
    const err = () =>
      sessionErrorEvent({ name: 'ApiError', data: { message: 'SSE read timed out' } })
    // Re-subscription streams 2..4, each carrying one error then ending
    const fake = resubscribingClient([fakeStream([err()]), fakeStream([err()]), fakeStream([err()])])
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Initial stream: one error then done (cycle 1)
    const { chunks, result } = await runEventStream(executor, [], { stream: fakeStream([err()]) })

    assert.equal(fake.prompts, 3, 'exactly 3 retries must fire')
    // 3 re-subscribes — the cap holds (no 4th re-subscribe)
    assert.equal(fake.subscribes, 3)
    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'exhaustion must yield a terminal error chunk')
    assert.match(errorChunks[errorChunks.length - 1].error ?? '', /timed out/)
    assert.equal(result.transientRetries, 3)
    assert.equal(result.endedWithTerminalError, true)
  })

  test('clean end without retry → no extra subscribe', async () => {
    const executor = new OpenCodeExecutor()
    const fake = resubscribingClient([])
    ;(executor as unknown as { client: unknown }).client = fake.client

    const { result } = await runEventStream(executor, [], {
      stream: fakeStream([textPartEvent('ok'), sessionIdleEvent()])
    })

    assert.equal(fake.subscribes, 0, 'no re-subscribe may happen without a pending resend')
    assert.equal(result.transientRetries, 0)
    assert.equal(result.endedWithTerminalError, false)
  })
})

describe('processEventStream — PARITY FIX (F): heartbeat-immune stall watcher', () => {
  test('heartbeats every 50ms do NOT defeat a 100ms stall window', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Manual stream: one activity event, then server.heartbeat events every
    // 50ms (held on a gate), releasable by the test.
    let heartbeats = 0
    let released = false
    let releasedEvent: unknown = null
    const manual: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]() {
        let sentActivity = false
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (!sentActivity) {
              sentActivity = true
              return Promise.resolve({ done: false, value: textPartEvent('working') })
            }
            if (released) {
              return releasedEvent
                ? Promise.resolve({ done: false, value: releasedEvent })
                : Promise.resolve({ done: true, value: undefined })
            }
            return new Promise<IteratorResult<unknown>>((resolve) => {
              setTimeout(() => {
                if (released) {
                  resolve(
                    releasedEvent
                      ? { done: false, value: releasedEvent }
                      : { done: true, value: undefined }
                  )
                } else {
                  heartbeats++
                  resolve({ done: false, value: { type: 'server.heartbeat', properties: {} } })
                }
              }, 50)
            })
          }
        }
      }
    }

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: manual },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      midTurnStallMs: 100
    })

    const chunks: StreamChunk[] = []
    const consumer = (async () => {
      let r = await gen.next()
      while (!r.done) {
        chunks.push(r.value as StreamChunk)
        r = await gen.next()
      }
      return r.value as StreamRunResult
    })()

    // The stall (100ms) must fire while heartbeats (50ms cadence) keep flowing.
    // Poll for the RE-SENT PROMPT (not the abort — it fires synchronously before
    // the scaled 30ms backoff sleep completes).
    const deadline = Date.now() + 2000
    while (fake.prompts < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    // At least one heartbeat must have flowed during the window — under load
    // the 50ms heartbeat timer can slip past the 100ms stall window, but even
    // ONE heartbeat + a stall firing at ~100ms proves immunity (the old code
    // would have pushed the window to 150ms+ on that heartbeat).
    assert.ok(heartbeats >= 1, `heartbeats must have flowed during the window (got ${heartbeats})`)
    assert.equal(fake.aborts, 1, 'stall must fire despite heartbeats')
    assert.equal(fake.prompts, 1, 'stall retry must re-send the prompt')

    // Release immediately so the re-armed 100ms window doesn't fire again —
    // the recovered activity re-arms it legitimately.
    released = true
    releasedEvent = sessionIdleEvent()
    const result = await consumer

    assert.equal(result.transientRetries, 1)
    assert.equal(result.lastTransientClass, 'slow')
  })
})

describe('execute — PARITY FIX (I): session poisoning after retry exhaustion', () => {
  test('retry exhaustion removes the conversation→session mapping', async () => {
    const executor = new OpenCodeExecutor()
    const err = () =>
      sessionErrorEvent({ name: 'ApiError', data: { message: 'SSE read timed out' } })
    const fake = resubscribingClient([fakeStream([err(), err(), err(), err()])])
    ;(executor as unknown as { client: unknown }).client = fake.client
    ;(executor as unknown as { isStarted: boolean }).isStarted = true

    // Pre-seed the mapping the way getOrCreateSession would
    const sessionMap = (executor as unknown as { sessionMap: Map<string, string> }).sessionMap
    sessionMap.set('conv-poison', SID)

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const execute = proto.execute.bind(executor)
    shrinkRetryDelays(executor)

    const chunks: Array<StreamChunk & { _meta?: unknown }> = []
    const gen = execute({
      prompt: 'do the thing',
      systemPrompt: 'sys',
      provider: { providerId: 'test', modelId: 'm1' },
      cwd: '/tmp',
      conversationId: 'conv-poison',
      maxTurns: 0
    })
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value)
      r = await gen.next()
    }

    // 1 initial prompt (execute) + 3 retries = 4 promptAsync calls
    assert.equal(fake.prompts, 4, 'exhaustion after exactly 3 retries (+1 initial send)')
    assert.ok(
      chunks.some((c) => c.type === 'error'),
      'terminal error chunk must be surfaced'
    )
    assert.equal(
      sessionMap.has('conv-poison'),
      false,
      'poisoned session mapping must be deleted — next turn starts fresh'
    )
  })

  test('clean turn keeps the session mapping (no poisoning)', async () => {
    const executor = new OpenCodeExecutor()
    const fake = resubscribingClient([fakeStream([textPartEvent('done'), sessionIdleEvent()])])
    ;(executor as unknown as { client: unknown }).client = fake.client
    ;(executor as unknown as { isStarted: boolean }).isStarted = true

    const sessionMap = (executor as unknown as { sessionMap: Map<string, string> }).sessionMap
    sessionMap.set('conv-keep', SID)

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const execute = proto.execute.bind(executor)
    shrinkRetryDelays(executor)

    const gen = execute({
      prompt: 'hello',
      systemPrompt: 'sys',
      provider: { providerId: 'test', modelId: 'm1' },
      cwd: '/tmp',
      conversationId: 'conv-keep',
      maxTurns: 0
    })
    let r = await gen.next()
    while (!r.done) {
      r = await gen.next()
    }

    assert.equal(sessionMap.has('conv-keep'), true, 'clean turn must keep the mapping')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
