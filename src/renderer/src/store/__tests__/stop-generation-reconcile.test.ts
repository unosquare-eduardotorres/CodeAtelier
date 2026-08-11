/**
 * reconcileStopState — the WEDGE-RECOVERY half of chat.store's stopGeneration.
 *
 * `sendingConversationIds` is set before the send IPC and cleared in its
 * finally block. If that finally is ever skipped, the input stays disabled
 * while nothing is running, and Stop is the user's only way out — so Stop must
 * reconcile against main rather than trust local state.
 *
 * The rule is extracted from the store so it can be tested without a renderer:
 * clear local flags only when main confirms nothing is streaming, and never on
 * a failed query.
 *
 * Run: tsx src/renderer/src/store/__tests__/stop-generation-reconcile.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { reconcileStopState } from '../chat-action-utils'

describe('reconcileStopState', () => {
  test('clears isStreaming and the active conversation when main reports idle', async () => {
    const patch = await reconcileStopState(
      async () => ({ isStreaming: false }),
      () => new Set(['conv-1', 'conv-2']),
      'conv-1'
    )

    assert.ok(patch, 'an idle backend must produce a patch')
    assert.equal(patch?.isStreaming, false)
    assert.deepEqual([...(patch?.sendingConversationIds ?? [])], ['conv-2'])
  })

  test('leaves local state alone while main is still streaming', async () => {
    const patch = await reconcileStopState(
      async () => ({ isStreaming: true }),
      () => new Set(['conv-1']),
      'conv-1'
    )

    assert.equal(patch, null, 'clearing flags mid-stream would re-enable the input too early')
  })

  test('swallows a throw from the streaming-state query', async () => {
    const errors: unknown[] = []
    const patch = await reconcileStopState(
      async () => {
        throw new Error('IPC unavailable')
      },
      () => new Set(['conv-1']),
      'conv-1',
      (error) => errors.push(error)
    )

    assert.equal(patch, null, 'a failed query must not clobber the only state we have')
    assert.equal(errors.length, 1, 'the failure is reported, not silently dropped')
    assert.equal((errors[0] as Error).message, 'IPC unavailable')
  })

  test('a throw without an error callback still resolves instead of rejecting', async () => {
    // stopGeneration awaits this — an unhandled rejection would strand the
    // stop path halfway through.
    const patch = await reconcileStopState(
      async () => {
        throw new Error('boom')
      },
      () => new Set(),
      'conv-1'
    )
    assert.equal(patch, null)
  })

  test('reads sendingConversationIds after the await, not before', async () => {
    // A send can start during the IPC round-trip; reading the set eagerly would
    // resurrect a stale snapshot and re-disable the input.
    let current = new Set(['conv-1'])
    const patch = await reconcileStopState(
      async () => {
        current = new Set(['conv-1', 'conv-late'])
        return { isStreaming: false }
      },
      () => current,
      'conv-1'
    )

    assert.deepEqual([...(patch?.sendingConversationIds ?? [])], ['conv-late'])
  })

  test('does not mutate the caller’s set', async () => {
    const original = new Set(['conv-1'])
    await reconcileStopState(
      async () => ({ isStreaming: false }),
      () => original,
      'conv-1'
    )
    assert.deepEqual([...original], ['conv-1'], 'zustand state must never be mutated in place')
  })

  test('releases a wedged conversation while a DIFFERENT conversation streams', async () => {
    // The top-level `isStreaming` from main is the deprecated global flag — it is
    // true whenever ANY conversation streams. Trusting it kept a wedged chat's
    // composer locked because an unrelated background chat was busy.
    const patch = await reconcileStopState(
      async () => ({
        isStreaming: true,
        streams: [{ conversationId: 'conv-2', requestId: 'req-2' }]
      }),
      () => new Set(['conv-1']),
      'conv-1'
    )

    assert.ok(patch, 'conv-1 has no stream of its own — it must be released')
    assert.deepEqual([...(patch?.sendingConversationIds ?? [])], [])
  })

  test('still declines while THIS conversation has a live stream', async () => {
    const patch = await reconcileStopState(
      async () => ({
        isStreaming: true,
        streams: [
          { conversationId: 'conv-1', requestId: 'req-1' },
          { conversationId: 'conv-2', requestId: 'req-2' }
        ]
      }),
      () => new Set(['conv-1']),
      'conv-1'
    )

    assert.equal(patch, null, 'a genuinely busy conversation must stay locked')
  })

  test('an empty streams list releases even when the global flag is set', async () => {
    const patch = await reconcileStopState(
      async () => ({ isStreaming: true, streams: [] }),
      () => new Set(['conv-1']),
      'conv-1'
    )

    assert.ok(patch, 'no live streams at all — nothing can justify keeping the input locked')
    assert.deepEqual([...(patch?.sendingConversationIds ?? [])], [])
  })

  test('falls back to the legacy global flag when main sends no streams list', async () => {
    // Version skew only: renderer and main ship together, but the fallback must
    // preserve the old behaviour rather than crash.
    const patch = await reconcileStopState(
      async () => ({ isStreaming: true }),
      () => new Set(['conv-1']),
      'conv-1'
    )

    assert.equal(patch, null)
  })

  test('handles a null active conversation without clearing anyone else', async () => {
    const patch = await reconcileStopState(
      async () => ({ isStreaming: false }),
      () => new Set(['conv-1']),
      null
    )
    assert.deepEqual([...(patch?.sendingConversationIds ?? [])], ['conv-1'])
  })
})

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('stop-generation-reconcile')) {
  void summaryAsync()
}
