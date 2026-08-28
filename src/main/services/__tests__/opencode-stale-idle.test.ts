/**
 * Tests for the stale session.idle guard in opencode-executor.ts.
 *
 * Bug (v1.0.86, GLM via OpenCode): every turn ended in ~15–70ms with chunks=2,
 * textLen=0, input=0 output=0 — the model was never queried. A stale
 * session.idle from the just-finished priming prompt (or an orphaned prior
 * prompt on the same session) arrived immediately after event.subscribe(),
 * passed the sessionID filter in isSessionComplete(), and broke the stream
 * before the real prompt produced any activity.
 *
 * Fix: track sawTurnActivity in processEventStream — session.idle /
 * session.status:idle only terminate once an event that can only belong to
 * OUR prompt (assistant text/thinking, tool traffic, structured output,
 * permission asks, subagent progress, V2 step start) has been seen.
 * session.error / session.next.step.failed stay ungated.
 *
 * Synthetic SSE event bus — no network, no SDK. Same prototype-cast pattern
 * as opencode-executor-event-stream.test.ts.
 *
 * Run: npx tsx src/main/services/__tests__/opencode-stale-idle.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { OpenCodeExecutor } from '../opencode-executor'
import type { StreamChunk } from '../agent-base.service'

const SID = 'synthetic-session-1'

// ── Synthetic event helpers ──

function textPartEvent(content: string, sessionID = SID) {
  return {
    type: 'message.part.updated',
    properties: { sessionID, part: { type: 'text', content } }
  }
}

function sessionIdleEvent(sessionID = SID) {
  return { type: 'session.idle', properties: { sessionID } }
}

function sessionStatusIdleEvent(sessionID = SID) {
  return { type: 'session.status', properties: { sessionID, status: 'idle' } }
}

function sessionErrorEvent(message: string, sessionID = SID) {
  return { type: 'session.error', properties: { sessionID, error: message } }
}

function stepStartedEvent(sessionID = SID) {
  return { type: 'session.next.step.started', properties: { sessionID } }
}

/** Create an async iterable from an array of events */
async function* fakeStream(events: unknown[]): AsyncIterable<unknown> {
  for (const e of events) yield e
}

// ── Access private method via prototype cast ──

async function collectChunks(
  executor: OpenCodeExecutor,
  events: unknown[],
  noActivityTimeoutMs?: number
): Promise<{ chunks: StreamChunk[]; resultText: string }> {
  const proto = OpenCodeExecutor.prototype as unknown as Record<
    string,
    (...args: any[]) => any
  >
  const processEventStream = proto.processEventStream.bind(executor)

  const gen = processEventStream({
    events: { stream: fakeStream(events) },
    openCodeSessionId: SID,
    promptBody: { parts: [{ type: 'text', text: 'test' }] },
    tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    maxTurns: 0,
    ...(noActivityTimeoutMs !== undefined ? { noActivityTimeoutMs } : {})
  })

  const chunks: StreamChunk[] = []
  let result = await gen.next()
  while (!result.done) {
    chunks.push(result.value as StreamChunk)
    result = await gen.next()
  }
  return { chunks, resultText: result.value.resultText }
}

// ── Tests ──

describe('processEventStream — stale session.idle guard', () => {
  test('stale idle (same sessionID) before activity → stream continues, turn completes with text', async () => {
    const executor = new OpenCodeExecutor()
    // The v1.0.86 GLM bug: priming-tail idle arrives first, then the real
    // prompt's text + idle. The stale idle must NOT terminate the turn.
    const { chunks, resultText } = await collectChunks(executor, [
      sessionIdleEvent(), // stale — from the just-finished priming prompt
      textPartEvent('Here are the questions'),
      sessionIdleEvent() // real completion
    ])

    const textChunks = chunks.filter((c) => c.type === 'text')
    assert.ok(textChunks.length >= 1, 'Should emit the real text after the stale idle')
    assert.equal(textChunks[0].content, 'Here are the questions')
    assert.equal(resultText, 'Here are the questions')
  })

  test('stale session.status:idle before activity → ignored, turn continues', async () => {
    const executor = new OpenCodeExecutor()
    const { chunks, resultText } = await collectChunks(executor, [
      sessionStatusIdleEvent(), // stale
      textPartEvent('answer'),
      sessionIdleEvent()
    ])

    assert.ok(chunks.some((c) => c.type === 'text' && c.content === 'answer'))
    assert.equal(resultText, 'answer')
  })

  test('idle after activity → terminates normally (regression guard)', async () => {
    const executor = new OpenCodeExecutor()
    const { chunks, resultText } = await collectChunks(executor, [
      textPartEvent('Hello'),
      sessionIdleEvent()
    ])

    const textChunks = chunks.filter((c) => c.type === 'text')
    assert.equal(textChunks.length, 1)
    assert.equal(textChunks[0].content, 'Hello')
    assert.equal(resultText, 'Hello')
  })

  test('session.error before activity → still terminates (not gated)', async () => {
    const executor = new OpenCodeExecutor()
    const { chunks } = await collectChunks(executor, [
      sessionErrorEvent('invalid api key')
    ])

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Genuine errors must terminate even before activity')
    assert.equal(errorChunks[0].error, 'invalid api key')
  })

  test('idle with different sessionID → ignored (existing behavior preserved)', async () => {
    const executor = new OpenCodeExecutor()
    const { chunks, resultText } = await collectChunks(executor, [
      sessionIdleEvent('other-session'), // different session — filtered out entirely
      textPartEvent('mine'),
      sessionIdleEvent()
    ])

    assert.ok(chunks.some((c) => c.type === 'text' && c.content === 'mine'))
    assert.equal(resultText, 'mine')
  })

  test('V2 step.started counts as activity — idle after it terminates', async () => {
    const executor = new OpenCodeExecutor()
    const { chunks } = await collectChunks(executor, [
      sessionIdleEvent(), // stale
      stepStartedEvent(), // V2 activity signal (normalizes to zero chunks)
      sessionIdleEvent() // now terminal
    ])

    assert.ok(
      !chunks.some((c) => c.type === 'error'),
      'No error should be emitted for the stale-idle-then-step-started sequence'
    )
  })

  test('no-activity backstop: stream that never emits activity times out with an error', async () => {
    const executor = new OpenCodeExecutor()
    // Stream that hangs forever after delivering one stale idle — the
    // no-activity timeout must fire instead of hanging the turn.
    async function* hangingStream(): AsyncIterable<unknown> {
      yield sessionIdleEvent()
      await new Promise(() => {}) // never resolves
    }
    const proto = OpenCodeExecutor.prototype as unknown as Record<
      string,
      (...args: any[]) => any
    >
    const processEventStream = proto.processEventStream.bind(executor)
    const gen = processEventStream({
      events: { stream: hangingStream() },
      openCodeSessionId: SID,
      promptBody: { parts: [{ type: 'text', text: 'test' }] },
      tokenUsage: { input: 0, output: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      maxTurns: 0,
      noActivityTimeoutMs: 50
    })

    const chunks: StreamChunk[] = []
    let result = await gen.next()
    while (!result.done) {
      chunks.push(result.value as StreamChunk)
      result = await gen.next()
    }

    const errorChunks = chunks.filter((c) => c.type === 'error')
    assert.ok(errorChunks.length >= 1, 'Timeout should surface an error chunk')
    assert.match(String(errorChunks[0].error), /no prompt activity/i)
  })

  test('empty text chunks do not count as activity (idle still stale)', async () => {
    const executor = new OpenCodeExecutor()
    // message.updated with an empty text part normalizes to zero chunks —
    // a following idle must still be treated as stale.
    const { chunks, resultText } = await collectChunks(executor, [
      { type: 'message.updated', properties: { sessionID: SID, part: { type: 'text' } } },
      sessionIdleEvent(), // still stale — no real activity yet
      textPartEvent('late answer'),
      sessionIdleEvent()
    ])

    assert.ok(chunks.some((c) => c.type === 'text' && c.content === 'late answer'))
    assert.equal(resultText, 'late answer')
  })
})

// ── isSessionComplete — unit level ──

describe('isSessionComplete — sawTurnActivity gating', () => {
  const executor = new OpenCodeExecutor()

  test('session.idle with sawTurnActivity=false → false (stale)', () => {
    const event = { type: 'session.idle', properties: { sessionID: SID } }
    assert.equal((executor as any).isSessionComplete(event, SID, false, false), false)
  })

  test('session.idle with sawTurnActivity=true → true', () => {
    const event = { type: 'session.idle', properties: { sessionID: SID } }
    assert.equal((executor as any).isSessionComplete(event, SID, false, true), true)
  })

  test('session.status:idle with sawTurnActivity=false → false (stale)', () => {
    const event = { type: 'session.status', properties: { sessionID: SID, status: 'idle' } }
    assert.equal((executor as any).isSessionComplete(event, SID, false, false), false)
  })

  test('session.error with sawTurnActivity=false → still true (ungated)', () => {
    const event = { type: 'session.error', properties: { sessionID: SID } }
    assert.equal((executor as any).isSessionComplete(event, SID, false, false), true)
  })

  test('session.next.step.failed with sawTurnActivity=false → still true (ungated)', () => {
    const event = { type: 'session.next.step.failed', properties: { sessionID: SID } }
    assert.equal((executor as any).isSessionComplete(event, SID, false, false), true)
  })

  test('legacy 3-arg call: idle defaults to stale (safe default)', () => {
    const event = { type: 'session.idle', properties: { sessionID: SID } }
    // The 4th arg defaults to false — a caller that doesn't track activity
    // gets the conservative stale-idle behavior, never a premature break.
    assert.equal((executor as any).isSessionComplete(event, SID, false), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
