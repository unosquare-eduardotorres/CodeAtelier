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

/** G2: a message.part.updated carrying a NESTED part.sessionID (opencode ≥1.17 shape). */
function partEventForSession(sessionId: string, content: string) {
  return {
    type: 'message.part.updated',
    properties: { part: { type: 'text', content, sessionID: sessionId } }
  }
}

/** NO-WRITE NUDGE: a V2 tool.called event for a given tool + callID. */
function toolCalledEvent(toolName: string, callId: string) {
  return {
    type: 'session.next.tool.called',
    properties: { tool: toolName, callID: callId }
  }
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

/**
 * STALL-RETRY ECHO FIX (T006) helper: a stream that emits `pre` promptly,
 * then hangs on a gate (optionally emitting server.heartbeat events while
 * hung — heartbeatMs > 0), and after release() emits `post` promptly then
 * ends. Models the live shape: activity → stall → abort+resend → the aborted
 * run's echo events → the resent run's events.
 */
function stallGateStream(
  pre: unknown[],
  post: unknown[],
  heartbeatMs = 0
): { release: () => void; heartbeats: () => number; stream: AsyncIterable<unknown> } {
  let released = false
  let beats = 0
  let preIdx = 0
  let postIdx = 0
  const takePost = (): IteratorResult<unknown> =>
    postIdx < post.length ? { done: false, value: post[postIdx++] } : { done: true, value: undefined }
  return {
    release: () => {
      released = true
    },
    heartbeats: () => beats,
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (preIdx < pre.length) {
            return Promise.resolve({ done: false, value: pre[preIdx++] })
          }
          if (postIdx >= post.length) return Promise.resolve({ done: true, value: undefined })
          if (released) return Promise.resolve(takePost())
          if (heartbeatMs > 0) {
            return new Promise((resolve) => {
              setTimeout(() => {
                if (released) resolve(takePost())
                else {
                  beats++
                  resolve({ done: false, value: { type: 'server.heartbeat', properties: {} } })
                }
              }, heartbeatMs)
            })
          }
          return new Promise((resolve) => {
            const poll = setInterval(() => {
              if (released) {
                clearInterval(poll)
                resolve(takePost())
              }
            }, 5)
          })
        }
      })
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
  const subscribeArgs: unknown[] = []
  const queue = [...streams]
  return {
    client: {
      event: {
        subscribe: (opts?: unknown) => {
          calls.subscribes++
          subscribeArgs.push(opts)
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
    get subscribeArgs() {
      return subscribeArgs
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
    // test releases after asserting the stall fired. Post-fix, the released
    // events must include the RESENT run's activity before the idle — an
    // idle arriving while the resend is pending belongs to the aborted run
    // and no longer terminates the turn (STALL-RETRY ECHO FIX).
    const gate = stallGateStream(
      [textPartEvent('working on it')],
      [textPartEvent('recovered answer'), sessionIdleEvent()]
    )

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: gate.stream },
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

    // Release the stream — the resent run's activity then a genuine idle
    gate.release()
    const result = await consumer

    assert.equal(result.transientRetries, 1)
    assert.equal(result.lastTransientClass, 'slow')
    assert.equal(result.endedWithTerminalError, false)
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
    // 50ms (held on a gate), releasable by the test. Post-fix the released
    // events must carry the resent run's activity before the idle (an idle
    // while the resend is pending belongs to the aborted run).
    const gate = stallGateStream(
      [textPartEvent('working')],
      [textPartEvent('recovered'), sessionIdleEvent()],
      50
    )

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: gate.stream },
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
    assert.ok(
      gate.heartbeats() >= 1,
      `heartbeats must have flowed during the window (got ${gate.heartbeats()})`
    )
    assert.equal(fake.aborts, 1, 'stall must fire despite heartbeats')
    assert.equal(fake.prompts, 1, 'stall retry must re-send the prompt')

    // Release immediately so the re-armed 100ms window doesn't fire again —
    // the recovered activity re-arms it legitimately.
    gate.release()
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

describe('processEventStream — NO-WRITE NUDGE: build-mode course-correction', () => {
  test('8 read-only tool calls → exactly ONE nudge promptAsync + status chunk', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // 8 read-only tool calls then idle — the nudge must fire once at call 8
    const events: unknown[] = []
    for (let i = 0; i < 8; i++) events.push(toolCalledEvent('read', `call-${i}`))
    events.push(sessionIdleEvent())

    const { chunks } = await runEventStream(executor, events, {} as never)
    // Re-run with the nudge flag via direct generator invocation
    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    const nudgedChunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      nudgedChunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    // The nudge re-sent exactly one promptAsync (beyond the initial send which
    // processEventStream doesn't perform — fake.prompts counts only nudge/resend)
    assert.equal(fake.prompts, 1, 'exactly one nudge must be queued')
    assert.ok(
      nudgedChunks.some(
        (c) => c.type === 'status' && c.content?.includes('no-write nudge')
      ),
      'nudge status chunk must be surfaced'
    )
    // Sanity: the first (non-nudged) run produced no nudge
    assert.ok(
      !chunks.some((c) => c.type === 'status' && c.content?.includes('no-write nudge')),
      'nudge must not fire when enableNoWriteNudge is unset'
    )
  })

  test('write-class tool before threshold suppresses the nudge', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    const events: unknown[] = [toolCalledEvent('read', 'c0'), toolCalledEvent('write', 'c1')]
    for (let i = 2; i < 10; i++) events.push(toolCalledEvent('read', `c${i}`))
    events.push(sessionIdleEvent())
    // (assertions below — bash regression case follows in its own test)

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()

    assert.equal(fake.prompts, 0, 'no nudge may fire once a write tool was seen')
  })

  test('read-only bash does NOT suppress the nudge (T002 regression)', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Live evidence: T002 ran bash=4 (ls/git status — read-only), writes=0,
    // and the nudge never fired because bash counted as write-class.
    const events: unknown[] = [
      toolCalledEvent('read', 'c0'),
      toolCalledEvent('bash', 'c1'),
      toolCalledEvent('bash', 'c2'),
      toolCalledEvent('glob', 'c3'),
      toolCalledEvent('bash', 'c4'),
      toolCalledEvent('bash', 'c5'),
      toolCalledEvent('grep', 'c6'),
      toolCalledEvent('read', 'c7'),
      toolCalledEvent('read', 'c8'),
      sessionIdleEvent()
    ]

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    const chunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    assert.equal(fake.prompts, 1, 'read-only bash must not suppress the nudge')
    assert.ok(
      chunks.some((c) => c.type === 'status' && c.content?.includes('no-write nudge')),
      'nudge status must surface on a bash-heavy read-only turn'
    )
  })

  test('text-volume trigger fires with few tool calls (T001 run-3 regression)', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Live evidence: T001 run 3 — ~6 tool calls, 61K chars of narrated
    // migration, zero writes, turn "completed" with the file never created.
    // The tool-count trigger never fires on this shape; text volume must.
    const events: unknown[] = [
      toolCalledEvent('read', 'c0'),
      toolCalledEvent('read', 'c1'),
      toolCalledEvent('bash', 'c2'),
      // One giant narration chunk (61K chars) — exceeds the 12K threshold
      textPartEvent('X'.repeat(61_000)),
      sessionIdleEvent()
    ]

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input:0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    const chunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    assert.equal(fake.prompts, 1, 'text-volume trigger must fire the nudge')
    assert.ok(
      chunks.some((c) => c.type === 'status' && c.content?.includes('text volume')),
      'text-volume nudge status must surface'
    )
  })

  test('nudge never fires twice even with 20 read-only calls', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    const events: unknown[] = []
    for (let i = 0; i < 20; i++) events.push(toolCalledEvent('grep', `call-${i}`))
    events.push(sessionIdleEvent())

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()

    assert.equal(fake.prompts, 1, 'nudge is one-shot per turn')
  })
})

describe('processEventStream — GLM "Failed to execute statement" is transient', () => {
  test('statement error triggers retry instead of terminating the turn', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Live evidence: T002/T004 died mid-loop on this bare error string —
    // no pattern matched, no retry fired, the turn ended truncated.
    // Post STALL-RETRY ECHO FIX: the idle right after the failed run's error
    // arrives while the resend is pending and is ignored; the resent run's
    // activity clears the flag and a LATER idle is the genuine completion.
    const { chunks, result } = await runEventStream(executor, [
      textPartEvent('working'),
      sessionErrorEvent({ name: 'UnknownError', data: { message: 'Failed to execute statement' } }),
      sessionIdleEvent(), // the failed run's idle — ignored while resend pending
      textPartEvent('recovered work'),
      sessionIdleEvent() // genuine completion of the resent run
    ])

    assert.ok(
      chunks.some((c) => c.type === 'session_recovery'),
      'statement error must trigger the retry path'
    )
    assert.equal(fake.prompts, 1, 'prompt must be re-sent once')
    assert.equal(result.transientRetries, 1)
    assert.equal(result.endedWithTerminalError, false)
  })
})

describe('processEventStream — G1: no-activity timeout poisons the session', () => {
  test('no-activity timeout sets endedWithTerminalError=true', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // A stream that never emits anything — the pre-activity backstop fires
    const hanging = stallingStream([])
    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    const gen = processEventStream({
      events: { stream: hanging },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      noActivityTimeoutMs: 80
    })
    const chunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    assert.equal(
      (r.value as StreamRunResult).endedWithTerminalError,
      true,
      'no-activity timeout must poison the turn (G1)'
    )
    assert.ok(
      chunks.some((c) => c.type === 'error' && c.error?.includes('no prompt activity')),
      'timeout error chunk must be surfaced'
    )
    assert.equal(fake.aborts, 1, 'zombie prompt must be aborted')
  })
})

describe('processEventStream — G2: sibling-session parts are not our activity', () => {
  test('sibling session text part produces NO chunks (nested part.sessionID filter)', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      partEventForSession('sibling-session-xyz', 'sibling chatter')
    ])

    assert.equal(
      chunks.filter((c) => c.type === 'text').length,
      0,
      'sibling-session part must not normalize as our text'
    )
  })

  test('own-session part with nested sessionID still normalizes', async () => {
    const executor = new OpenCodeExecutor()
    const chunks = await collectChunks(executor, [
      partEventForSession(SID, 'our own text'),
      sessionIdleEvent()
    ])

    assert.ok(
      chunks.some((c) => c.type === 'text' && c.content === 'our own text'),
      'own-session part must still normalize'
    )
  })
})

describe('processEventStream — STALL-RETRY ECHO FIX (T006): abort echo must not kill the turn', () => {
  test('stall → abort echo + aborted-run idle ignored → resent run observed, no "Aborted" error', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Live evidence (T006, 21:38:57→21:39:27): GLM stalled 240s mid-generation,
    // the watcher aborted the zombie prompt and re-sent — then the abort's OWN
    // echo events (session.error "Aborted" + session.idle for the aborted run)
    // terminated the turn before the resent prompt ran. The migration was
    // never written and the UI showed "executor error: Aborted".
    const gate = stallGateStream(
      [textPartEvent('working on the migration')],
      [
        sessionErrorEvent('Aborted'), // our own abort's echo — must be suppressed
        sessionIdleEvent(), // the aborted run's idle — must not terminate
        textPartEvent('re-sent run answer'), // the resent run's activity
        sessionIdleEvent() // genuine completion
      ]
    )

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)

    const gen = processEventStream({
      events: { stream: gate.stream },
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

    const deadline = Date.now() + 2000
    while (fake.prompts < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }
    assert.equal(fake.aborts, 1, 'the stall must abort the zombie prompt')
    assert.equal(fake.prompts, 1, 'the stall retry must re-send the prompt')

    gate.release()
    const result = await consumer

    assert.ok(
      !chunks.some((c) => c.type === 'error' && /abort/i.test(c.error ?? '')),
      'the abort echo must NOT be yielded as an error chunk (executorErrorBox must never see it)'
    )
    assert.ok(
      chunks.some((c) => c.type === 'text' && c.content === 're-sent run answer'),
      'the resent run\'s text must be observed'
    )
    assert.equal(result.transientRetries, 1)
    assert.equal(result.endedWithTerminalError, false)
  })

  test('isSessionComplete: idle and abort-error are non-terminal only while a resend is pending', () => {
    const executor = new OpenCodeExecutor()
    const anyExec = executor as unknown as {
      isSessionComplete: (
        event: unknown,
        sessionId: string,
        retriesAvailable?: boolean,
        sawTurnActivity?: boolean,
        resendPending?: boolean
      ) => boolean
    }
    // While the resend is pending: aborted-run idle + abort echo are ignored
    assert.equal(anyExec.isSessionComplete(sessionIdleEvent(), SID, false, true, true), false)
    assert.equal(anyExec.isSessionComplete(sessionErrorEvent('Aborted'), SID, false, true, true), false)
    // Once the resend ran (flag cleared): idle is genuine, abort-shaped errors terminal
    assert.equal(anyExec.isSessionComplete(sessionIdleEvent(), SID, false, true, false), true)
    assert.equal(anyExec.isSessionComplete(sessionErrorEvent('Aborted'), SID, false, true, false), true)
    // Non-abort errors stay terminal even while a resend is pending
    assert.equal(
      anyExec.isSessionComplete(sessionErrorEvent('invalid model'), SID, false, true, true),
      true
    )
  })
})

describe('processEventStream — NO-WRITE NUDGE escalation (T005): second, final nudge', () => {
  test('tool-count nudge → 12K more chars → escalated final nudge; a third 12K does not fire', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    // Live evidence (T005): the first nudge queued behind a 52K-char narration
    // the model could not interrupt; the turn ended with writes=0. One more
    // volume-triggered nudge is now allowed, with escalated text.
    const events: unknown[] = []
    for (let i = 0; i < 8; i++) events.push(toolCalledEvent('read', `c${i}`))
    events.push(textPartEvent('X'.repeat(12_500))) // +12K post-nudge narration → final nudge
    events.push(textPartEvent('Y'.repeat(12_500))) // another 12K → NO third nudge
    events.push(sessionIdleEvent())

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    const chunks: StreamChunk[] = []
    let r = await gen.next()
    while (!r.done) {
      chunks.push(r.value as StreamChunk)
      r = await gen.next()
    }

    assert.equal(fake.prompts, 2, 'exactly two nudges: initial (tool count) + final (text volume)')
    const statuses = chunks
      .filter((c) => c.type === 'status')
      .map((c) => c.content ?? '')
    assert.ok(
      statuses.some((s) => s.includes('no-write nudge sent —')),
      'the first (tool-count) nudge status must surface'
    )
    assert.ok(
      statuses.some((s) => s.includes('no-write nudge sent (final)')),
      'the escalated final nudge status must surface'
    )
    assert.equal(
      statuses.filter((s) => s.includes('no-write nudge')).length,
      2,
      'no third nudge may fire'
    )
  })

  test('write-class tool after the first nudge suppresses the escalated nudge', async () => {
    const executor = new OpenCodeExecutor()
    const fake = fakeClient()
    ;(executor as unknown as { client: unknown }).client = fake.client

    const events: unknown[] = []
    for (let i = 0; i < 8; i++) events.push(toolCalledEvent('read', `c${i}`))
    events.push(toolCalledEvent('write', 'cw')) // the model obeyed nudge #1
    events.push(textPartEvent('Z'.repeat(25_000))) // narration after the write
    events.push(sessionIdleEvent())

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    shrinkRetryDelays(executor)
    const gen = processEventStream({
      events: { stream: fakeStream(events) },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      enableNoWriteNudge: true
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()

    assert.equal(fake.prompts, 1, 'a write-class tool suppresses all further nudges')
  })
})

describe('getOrCreateSession — COLD-BOOTSTRAP RETRY: session.create 500s', () => {
  test('two 500s then success — retries with backoff, returns the session id', async () => {
    const executor = new OpenCodeExecutor()
    shrinkRetryDelays(executor)

    // Live shape (blueprint 718c wave 2): server.connected gate expired while
    // MCP servers were still handshaking; session.create 500'd with
    // "Unexpected server error" for BOTH concurrent tasks. The identical
    // create succeeds once bootstrap finishes.
    let calls = 0
    const fake = {
      session: {
        create: () => {
          calls++
          if (calls <= 2) {
            return Promise.resolve({
              data: undefined,
              error: { name: 'UnknownError', data: { message: 'Unexpected server error' } }
            })
          }
          return Promise.resolve({ data: { id: 'ses_retry_ok' } })
        },
        promptAsync: () => Promise.resolve()
      }
    }
    ;(executor as unknown as { client: unknown }).client = fake

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const getOrCreateSession = proto.getOrCreateSession.bind(executor)
    const sessionId = await getOrCreateSession({
      conversationId: 'conv-cold-boot',
      provider: { providerId: 'glm', modelId: 'glm-4.6' },
      cwd: '/tmp/some-worktree'
    })

    assert.equal(sessionId, 'ses_retry_ok', 'third attempt must succeed')
    assert.equal(calls, 3, 'exactly two retries must fire')
    // The mapping is registered so the next turn reuses the session
    const sessionMap = (executor as unknown as { sessionMap: Map<string, string> }).sessionMap
    assert.equal(sessionMap.get('conv-cold-boot'), 'ses_retry_ok')
  })

  test('persistent 500s — gives up after 3 attempts and returns undefined', async () => {
    const executor = new OpenCodeExecutor()
    shrinkRetryDelays(executor)

    let calls = 0
    const fake = {
      session: {
        create: () => {
          calls++
          return Promise.resolve({
            data: undefined,
            error: { name: 'UnknownError', data: { message: 'Unexpected server error' } }
          })
        },
        promptAsync: () => Promise.resolve()
      }
    }
    ;(executor as unknown as { client: unknown }).client = fake

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const getOrCreateSession = proto.getOrCreateSession.bind(executor)
    const sessionId = await getOrCreateSession({
      conversationId: 'conv-cold-boot-2',
      provider: { providerId: 'glm', modelId: 'glm-4.6' }
    })

    assert.equal(sessionId, undefined, 'exhausted retries must return undefined')
    assert.equal(calls, 3, '1 initial + 2 retries, no more')
  })

  test('a thrown create error is retried too (not just no-ID responses)', async () => {
    const executor = new OpenCodeExecutor()
    shrinkRetryDelays(executor)

    let calls = 0
    const fake = {
      session: {
        create: () => {
          calls++
          if (calls === 1) return Promise.reject(new Error('fetch failed'))
          return Promise.resolve({ data: { id: 'ses_throw_ok' } })
        },
        promptAsync: () => Promise.resolve()
      }
    }
    ;(executor as unknown as { client: unknown }).client = fake

    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const getOrCreateSession = proto.getOrCreateSession.bind(executor)
    const sessionId = await getOrCreateSession({
      conversationId: 'conv-cold-boot-3',
      provider: { providerId: 'glm', modelId: 'glm-4.6' }
    })

    assert.equal(sessionId, 'ses_throw_ok')
    assert.equal(calls, 2)
  })
})

describe('processEventStream — WORKTREE-SSE: directory-scoped subscription', () => {
  test('execute subscribes with the directory query when cwd is a worktree', async () => {
    const executor = new OpenCodeExecutor()
    const fake = resubscribingClient([fakeStream([textPartEvent('ok'), sessionIdleEvent()])])
    ;(executor as unknown as { client: unknown }).client = fake.client
    ;(executor as unknown as { isStarted: boolean }).isStarted = true

    const sessionMap = (executor as unknown as { sessionMap: Map<string, string> }).sessionMap
    sessionMap.set('conv-wt', SID)

    const proto = OpenCodeExecutor.prototype as unknown as Record<string, (...args: any[]) => any>
    const execute = proto.execute.bind(executor)
    shrinkRetryDelays(executor)

    const gen = execute({
      prompt: 'build it',
      systemPrompt: 'sys',
      provider: { providerId: 'test', modelId: 'm1' },
      cwd: '/tmp/some-worktree',
      conversationId: 'conv-wt',
      maxTurns: 0
    })
    let r = await gen.next()
    while (!r.done) r = await gen.next()

    // The SSE subscription MUST carry the directory query — a directory-scoped
    // session's events never reach the global /event endpoint (verified live:
    // global SSE got only server.connected while the instance generated 120+).
    assert.equal(fake.subscribeArgs.length, 1)
    assert.deepEqual(fake.subscribeArgs[0], { query: { directory: '/tmp/some-worktree' } })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
