/**
 * reconcileBootStreamingState — the BOOT-REHYDRATE rule behind chat.store's
 * rehydrateStreamingState.
 *
 * The main process outlives a renderer-only reload (the `render-process-gone`
 * auto-reload in main/index.ts, RewindDialog's `window.location.reload`), so the
 * renderer can boot with empty state while streams are still running. The rule
 * is extracted from the store so it can be tested without a renderer.
 *
 * Run: tsx src/renderer/src/store/__tests__/boot-streaming-rehydrate.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  reconcileBootStreamingState,
  emptyStreamState,
  type PerConversationStreamState
} from '../chat-action-utils'

function emptyCurrent(activeConversationId: string | null = null): {
  streamingConversationIds: Set<string>
  conversationStreams: Map<string, PerConversationStreamState>
  activeConversationId: string | null
} {
  return {
    streamingConversationIds: new Set<string>(),
    conversationStreams: new Map<string, PerConversationStreamState>(),
    activeConversationId
  }
}

describe('reconcileBootStreamingState', () => {
  test('returns null when main reports no running streams', () => {
    assert.equal(reconcileBootStreamingState([], emptyCurrent()), null)
  })

  test('seeds ids and buffers for streams the renderer knows nothing about', () => {
    const patch = reconcileBootStreamingState(
      [{ conversationId: 'conv-a', requestId: 'req-a' }],
      emptyCurrent()
    )

    assert.ok(patch, 'a running stream must produce a patch')
    assert.deepEqual([...patch.streamingConversationIds], ['conv-a'])
    const buffer = patch.conversationStreams.get('conv-a')
    assert.equal(buffer?.isStreaming, true)
    // finalizeStreamAction compares the completion's requestId against this to
    // reject late chunks from a superseded request.
    assert.equal(buffer?.activeRequestId, 'req-a')
  })

  test('does not clobber a buffer that is already accumulating live chunks', () => {
    const current = emptyCurrent()
    current.streamingConversationIds.add('conv-a')
    current.conversationStreams.set('conv-a', {
      ...emptyStreamState(),
      streamingContent: 'half a sentence',
      activeRequestId: 'req-live',
      isStreaming: true
    })

    const patch = reconcileBootStreamingState(
      [{ conversationId: 'conv-a', requestId: 'req-a' }],
      current
    )

    assert.ok(patch)
    const buffer = patch.conversationStreams.get('conv-a')
    assert.equal(buffer?.streamingContent, 'half a sentence')
    assert.equal(buffer?.activeRequestId, 'req-live')
  })

  test('unions with ids the renderer is already tracking', () => {
    const current = emptyCurrent()
    current.streamingConversationIds.add('conv-known')

    const patch = reconcileBootStreamingState(
      [{ conversationId: 'conv-new', requestId: 'req-new' }],
      current
    )

    assert.ok(patch)
    assert.deepEqual([...patch.streamingConversationIds].sort(), ['conv-known', 'conv-new'])
  })

  test('sets isStreaming only when the ACTIVE conversation is among the streams', () => {
    const background = reconcileBootStreamingState(
      [{ conversationId: 'conv-b', requestId: 'req-b' }],
      emptyCurrent('conv-a')
    )
    assert.equal(background?.isStreaming, false, 'a background stream must not lock the composer')
    assert.equal(background?.activeRequestId, null)

    const active = reconcileBootStreamingState(
      [
        { conversationId: 'conv-a', requestId: 'req-a' },
        { conversationId: 'conv-b', requestId: 'req-b' }
      ],
      emptyCurrent('conv-a')
    )
    assert.equal(active?.isStreaming, true)
    assert.equal(active?.activeRequestId, 'req-a')
  })

  test('a seeded buffer cannot produce a phantom blank message on completion', () => {
    // finalizeStreamAction only appends a message when
    // `streamingContent || streamingSegments.length > 0`. Content streamed
    // before the reload is lost, but main persists the finished message to the
    // DB, so it reappears on the next load — the renderer must not invent one.
    const patch = reconcileBootStreamingState(
      [{ conversationId: 'conv-a', requestId: 'req-a' }],
      emptyCurrent('conv-a')
    )

    const buffer = patch?.conversationStreams.get('conv-a')
    assert.equal(buffer?.streamingContent, '')
    assert.equal(buffer?.streamingSegments.length, 0)
  })

  test('does not mutate the caller’s collections', () => {
    const current = emptyCurrent()

    const patch = reconcileBootStreamingState(
      [{ conversationId: 'conv-a', requestId: 'req-a' }],
      current
    )

    assert.ok(patch)
    assert.equal(current.streamingConversationIds.size, 0)
    assert.equal(current.conversationStreams.size, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
