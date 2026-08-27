/**
 * Safety timeout must not leave streamed content orphaned.
 *
 * Reported symptom, in order: the agent's text disappeared from the transcript,
 * pressing Stop brought it back inside a "⏹ stopped" bubble, and it was then
 * replaced again on reload.
 *
 * Cause: the timeout cleared `conversationStreams` (the per-conversation
 * buffer) and the streaming flags, but never touched the TOP-LEVEL
 * `streamingContent` / `streamingSegments` / `toolActivities` — and
 * stopGeneration reads exactly those. The content was therefore invisible but
 * still live, waiting for the next Stop to resurrect it.
 *
 * These tests drive the real handler with a stub store, so they pin the state
 * a timeout leaves behind rather than a rendering coincidence.
 *
 * Run: tsx src/renderer/src/store/__tests__/safety-timeout-orphan.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'

// chat-streaming.actions imports through the `@renderer/*` alias, which only
// the Vite/tsconfig resolvers know about. Map it for the duration of the
// require, then put the resolver back so no other test file is affected.
const RENDERER_SRC = path.resolve(__dirname, '../..')
const resolver = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  const mapped = request.startsWith('@renderer/')
    ? path.join(RENDERER_SRC, request.slice('@renderer/'.length))
    : request
  return resolver.call(this, mapped, ...rest)
}
let ChatStreamingInternals: any
let loaded = false
try {
  ;({ ChatStreamingInternals } = require('../chat-streaming.actions'))
  loaded = true
} catch (err) {
  console.log('⚠ chat-streaming.actions load failed — safety-timeout tests skipped.')
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
} finally {
  ;(Module as any)._resolveFilename = resolver
}

interface StubState {
  [key: string]: any
}

/**
 * Fresh internals + minimal store stub: the slice handleSafetyTimeout and the
 * flush actually read. Tests in this harness run concurrently, so every one
 * gets its own instance, its own conversation id, and its own backend answer.
 */
function harness(
  convId: string,
  overrides: StubState = {},
  backendOwns: () => Promise<boolean> = async () => false
): { internals: any; state: StubState; backendCalls: () => number } {
  const state: StubState = {
    activeConversation: { id: convId },
    streamingConversationIds: new Set([convId]),
    sendingConversationIds: new Set([convId]),
    conversationStreams: new Map(),
    streamingContent: '',
    streamingSegments: [],
    toolActivities: [],
    streamingRole: 'specialist',
    streamingSpecialist: null,
    streamStalledConversationId: null,
    messages: [],
    pendingQuestions: null,
    pendingQuestionAction: null,
    pendingQuestionRequestId: null,
    isStreaming: true,
    activeRequestId: 'req-1',
    conversationState: {
      phase: 'specialist-responding',
      from: null,
      event: null,
      conversationId: convId
    },
    ...overrides
  }
  let calls = 0
  const internals = new ChatStreamingInternals()
  internals.bind(
    () => state,
    (patch: any) => {
      Object.assign(state, typeof patch === 'function' ? patch(state) : patch)
    }
  )
  // Stand in for the getStreamingState IPC — its own error handling is pinned
  // separately below.
  internals.backendStillOwns = async (): Promise<boolean> => {
    calls++
    return backendOwns()
  }
  return { internals, state, backendCalls: () => calls }
}

const QUESTION = [{ id: 'q1', question: 'which database?' }]

if (loaded) {
  describe('safety timeout — orphaned streaming content', () => {
    test('partial content is committed, not left for the next Stop to resurrect', async () => {
      const { internals, state } = harness('conv-orphan-1', { streamingContent: 'partial answer' })

      await internals.handleSafetyTimeout('conv-orphan-1')

      assert.equal(state.messages.length, 1, 'the streamed text was dropped on the floor')
      assert.match(state.messages[0].contentMd, /partial answer/)
      // The load-bearing assertion: stopGeneration reads exactly these three.
      assert.equal(
        state.streamingContent,
        '',
        'content survived the timeout and can be resurrected by the next Stop'
      )
      assert.deepEqual(state.streamingSegments, [])
      assert.deepEqual(state.toolActivities, [])
    })

    test('the conversation is still released', async () => {
      const { internals, state } = harness('conv-orphan-2', { streamingContent: 'partial answer' })

      await internals.handleSafetyTimeout('conv-orphan-2')

      assert.equal(
        state.streamingConversationIds.has('conv-orphan-2'),
        false,
        'sidebar spinner would linger'
      )
      assert.equal(
        state.sendingConversationIds.has('conv-orphan-2'),
        false,
        'composer would stay locked'
      )
      assert.equal(state.activeRequestId, null)
    })

    test('an empty turn commits nothing', async () => {
      const { internals, state } = harness('conv-orphan-3')

      await internals.handleSafetyTimeout('conv-orphan-3')

      assert.equal(state.messages.length, 0, 'a blank bubble was invented')
    })

    test('a conversation that already stopped streaming is untouched', async () => {
      const { internals, state } = harness('conv-orphan-4', {
        streamingConversationIds: new Set<string>(),
        streamingContent: 'finished normally'
      })

      await internals.handleSafetyTimeout('conv-orphan-4')

      assert.equal(state.streamingContent, 'finished normally', 'a live turn was flushed early')
      assert.equal(state.messages.length, 0)
    })
  })

  describe('safety timeout — main is consulted before any teardown', () => {
    test('ordinary silence still asks main whether it owns the stream', async () => {
      // Silence alone is not evidence of death: a background conversation
      // running a long tool emits only toolActivity chunks. Tearing down on
      // silence killed a stream main went on to serve for another two minutes.
      const { internals, state, backendCalls } = harness(
        'conv-gate-1',
        { streamingContent: 'x' },
        async () => true
      )

      try {
        await internals.handleSafetyTimeout('conv-gate-1')

        assert.equal(backendCalls(), 1, 'main was never asked before tearing the stream down')
        assert.equal(
          state.streamingConversationIds.has('conv-gate-1'),
          true,
          'a stream main still owns was torn down'
        )
      } finally {
        // The defer path re-arms a 2-minute timer.
        internals.clearSafetyTimer('conv-gate-1')
      }
    })

    test('a live gate survives — the card is not cleared', async () => {
      const { internals, state } = harness(
        'conv-gate-2',
        { pendingQuestions: QUESTION, pendingQuestionRequestId: 'req-1' },
        async () => true
      )

      try {
        await internals.handleSafetyTimeout('conv-gate-2')

        assert.ok(
          state.pendingQuestions,
          'the question card was cleared while main was still on it'
        )
        assert.equal(state.pendingQuestionRequestId, 'req-1')
        assert.equal(
          state.streamingConversationIds.has('conv-gate-2'),
          true,
          'the stream was torn down under an open question'
        )
      } finally {
        // The defer path re-arms a 2-minute timer.
        internals.clearSafetyTimer('conv-gate-2')
      }
    })

    test('a dead backend still clears the card — the watchdog is intact', async () => {
      const { internals, state } = harness(
        'conv-gate-3',
        { pendingQuestions: QUESTION, pendingQuestionRequestId: 'req-1' },
        async () => false
      )

      await internals.handleSafetyTimeout('conv-gate-3')

      assert.equal(state.pendingQuestions, null, 'an unanswerable question card was left on screen')
      assert.equal(state.streamingConversationIds.has('conv-gate-3'), false)
    })
  })

  describe('backendStillOwns', () => {
    /** The real implementation, with the streaming-state query injected. */
    const real = (convId: string, fetch: () => Promise<any>): Promise<boolean> => {
      const { internals } = harness(convId)
      delete internals.backendStillOwns // drop this file's stub
      return internals.backendStillOwns(convId, fetch)
    }

    test('ownership is read from the per-conversation streams list', async () => {
      const live = async (): Promise<any> => ({ streams: [{ conversationId: 'conv-api-1' }] })
      assert.equal(await real('conv-api-1', live), true)
      assert.equal(await real('someone-else', live), false)
    })

    test('a failed query reads as gone, never as alive', async () => {
      // A wedged main process is the exact failure this watchdog recovers from,
      // so it must not be able to disarm it.
      const throws = async (): Promise<any> => {
        throw new Error('IPC unavailable')
      }
      assert.equal(await real('conv-api-1', throws), false)
    })

    test('a response without a streams list reads as gone', async () => {
      assert.equal(await real('conv-api-1', async () => ({})), false)
    })
  })
}

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('safety-timeout-orphan.test.ts')

if (isDirectRun) {
  void summaryAsync()
}
