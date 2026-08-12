/**
 * Regression coverage for the "empty response text after send()" defect.
 *
 * MEMLEAK-01 made `_doSend` delete the per-conversation `activeStreams` entry as
 * soon as the stream finished. Because `send()` only resolves *after* `_doSend`
 * resolves, every caller that does
 *
 *     await session.send(...)
 *     const text = session.getStreamedContent(convId)
 *
 * read back `''` — silently. That is ~15 call sites (blueprint specify/clarify/
 * plan/tasks/review/verify/build, council, grill, audit, MPA), so clarify saw no
 * questions and specify/plan/tasks persisted empty artifacts.
 *
 * Nothing caught it: the existing tests only assert `getStreamedContent() === ''`
 * on a fresh instance, which is true either way. These tests drive a real
 * `send()` with a stubbed `executeStream` so the read-after-send contract is
 * pinned, while still asserting MEMLEAK-01's intent (no retained stream context).
 */
import assert from 'node:assert/strict'
import { describe, test } from './test-harness'
import { setupFullMock, createSpy } from './setup-full-mock'

setupFullMock()

const { AgentSessionService } = require('../agent-session.service')

const TURN_TEXT = [
  '```findings',
  '{"summary":"ok"}',
  '```',
  '```questions',
  '{"q1":{"question":"Which store?","options":["a","b","c"]}}',
  '```'
].join('\n')

function createMockAdapter(): Record<string, unknown> {
  return {
    role: 'chat',
    agentId: 'test-agent',
    refreshFeatureFlags: createSpy(),
    buildPrompts: createSpy(() => ({ systemPrompt: 'sys', effectiveMessage: 'msg' })),
    buildControlCallbacks: createSpy(() => ({})),
    buildMcpConfig: createSpy(() => ({ allowedTools: [], disallowedTools: [] })),
    onSendSuccess: createSpy(),
    onSessionStop: createSpy(),
    onStreamChunk: createSpy(),
    onStreamComplete: createSpy(),
    onStreamError: createSpy(),
    dispose: createSpy()
  }
}

/**
 * A session wired so `send()` runs the real `_doSend` pipeline but stops short of
 * spawning anything: the executor is replaced with a stub that fills the stream
 * accumulator exactly as the real stream processor would.
 */
function createSession(streamText: string = TURN_TEXT): any {
  const session = new AgentSessionService(createMockAdapter())

  session.workspacePath = '/tmp/ws'
  session.cwd = '/tmp/ws'
  // Avoid the worktree lookup and the control-actions socket — neither is
  // relevant to the text-handoff contract under test.
  session.resolveTrackPath = (): string => '/tmp/ws'
  session.ensureIpcBridge = async (): Promise<void> => {}
  session.executeStream = async ({ conversationId }: { conversationId: string }): Promise<void> => {
    const ctx = session.activeStreams.get(conversationId)
    assert.ok(ctx, 'executeStream must see a live stream context')
    ctx.accumulatedText = streamText
  }

  return session
}

describe('AgentSessionService — text survives turn teardown', () => {
  test('getStreamedContent returns the turn text after send() resolves', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')

    assert.equal(
      session.getStreamedContent('conv-1'),
      TURN_TEXT,
      'callers awaiting send() must be able to read the response back'
    )
  })

  test('getAccumulatedTextForConversation returns the turn text after send() resolves', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')

    assert.equal(session.getAccumulatedTextForConversation('conv-1'), TURN_TEXT)
  })

  test('MEMLEAK-01 intent holds — no activeStreams entry is retained after send()', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')

    assert.equal(session.activeStreams.size, 0, 'stream context must still be released')
    assert.equal(session.activeStreams.has('conv-1'), false)
  })

  test('text is scoped per conversation', async () => {
    const session = new AgentSessionService(createMockAdapter())
    session.workspacePath = '/tmp/ws'
    session.cwd = '/tmp/ws'
    session.resolveTrackPath = (): string => '/tmp/ws'
    session.ensureIpcBridge = async (): Promise<void> => {}
    session.executeStream = async ({
      conversationId
    }: {
      conversationId: string
    }): Promise<void> => {
      session.activeStreams.get(conversationId).accumulatedText = `text-for-${conversationId}`
    }

    await session.send('a', 'conv-a')
    await session.send('b', 'conv-b')

    assert.equal(session.getStreamedContent('conv-a'), 'text-for-conv-a')
    assert.equal(session.getStreamedContent('conv-b'), 'text-for-conv-b')
  })

  test('the next turn clears the previous turn text — no cross-turn bleed', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')
    assert.equal(session.getStreamedContent('conv-1'), TURN_TEXT)

    // A new turn starts: the stale text must be gone before the model replies,
    // otherwise a turn that yields nothing would re-parse the previous answer.
    session.resetForNewMessage('conv-1')
    assert.equal(session.getStreamedContent('conv-1'), '')
  })

  test('a turn that produced nothing reads back empty, not the prior turn', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')
    session.executeStream = async (): Promise<void> => {
      /* silent turn — accumulator stays empty */
    }
    await session.send('again', 'conv-1')

    assert.equal(session.getStreamedContent('conv-1'), '')
  })

  test('getLiveStreamedContent is empty once the turn is over', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')

    assert.equal(
      session.getLiveStreamedContent('conv-1'),
      '',
      'the Stop path must not resurrect an already-finalized turn'
    )
  })

  test('clearSession drops the retained text', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')
    session.clearSession('conv-1')

    assert.equal(session.getStreamedContent('conv-1'), '')
  })

  test('stop() drops retained text for every conversation', async () => {
    const session = createSession()

    await session.send('hello', 'conv-1')
    await session.stop()

    assert.equal(session.getStreamedContent('conv-1'), '')
    assert.equal(session.lastTurnText.size, 0)
  })

  test('retention is bounded to one entry per conversation', async () => {
    const session = createSession()

    await session.send('one', 'conv-1')
    await session.send('two', 'conv-1')
    await session.send('three', 'conv-1')

    assert.equal(session.lastTurnText.size, 1, 'turns must not accumulate')
  })
})
