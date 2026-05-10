/**
 * ConversationLifecycle tests — verifies the centralized abort/complete lifecycle
 * manager that cascades cleanup through every service touching a conversation.
 *
 * The singleton `conversationLifecycle` calls `conversationStateMachine.forceReset()`
 * on abort; we assert against the state machine's reset side-effect rather than
 * mocking it, since the two are designed as a cohesive pair.
 *
 * Kept synchronous so `run-tests.ts` style execution works without summaryAsync().
 *
 * Run: tsx src/main/services/__tests__/conversation-lifecycle.test.ts
 * Or via: npm run test:unit
 */

import assert from 'node:assert/strict'
import { ConversationLifecycle } from '../conversation-lifecycle'
import { conversationStateMachine } from '../conversation-state-machine'
import { test, describe, summary } from './test-harness'

/**
 * Build a fresh lifecycle for each test and reset the state machine — lifecycle
 * and the singleton state machine are coupled, so we isolate between cases.
 */
function freshLifecycle(): ConversationLifecycle {
  conversationStateMachine.forceReset()
  return new ConversationLifecycle()
}

describe('ConversationLifecycle — begin/complete basics', () => {
  test('is inactive before begin()', () => {
    const lc = freshLifecycle()
    assert.equal(lc.isActive, false)
    assert.equal(lc.requestId, null)
    assert.equal(lc.conversationId, null)
    assert.equal(lc.signal, null)
  })

  test('begin() sets conversationId and generates requestId', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    assert.equal(lc.isActive, true)
    assert.equal(lc.conversationId, 'conv-1')
    assert.notEqual(lc.requestId, null)
    assert.match(lc.requestId!, /^req-\d+-[a-z0-9]+$/)
    assert.ok(signal instanceof AbortSignal, 'returns an AbortSignal')
    assert.equal(signal.aborted, false)
  })

  test('each begin() generates a unique requestId', () => {
    const lc = freshLifecycle()
    lc.begin('conv-1')
    const first = lc.requestId
    lc.complete()
    // Sleep-free uniqueness — requestId uses Date.now() + random slice
    lc.begin('conv-2')
    const second = lc.requestId
    assert.notEqual(first, second)
  })

  test('complete() resets all state', () => {
    const lc = freshLifecycle()
    lc.begin('conv-1')
    assert.equal(lc.isActive, true)
    lc.complete()
    assert.equal(lc.isActive, false)
    assert.equal(lc.requestId, null)
    assert.equal(lc.conversationId, null)
    assert.equal(lc.signal, null)
  })

  test('complete() does NOT signal abort', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    lc.complete()
    assert.equal(signal.aborted, false, 'complete is a clean shutdown, not an abort')
  })
})

describe('ConversationLifecycle — disposer contract', () => {
  test('disposers run in registration order on complete()', () => {
    const lc = freshLifecycle()
    const order: string[] = []
    lc.begin('conv-1')
    lc.onDispose(() => order.push('first'))
    lc.onDispose(() => order.push('second'))
    lc.onDispose(() => order.push('third'))
    lc.complete()
    assert.deepEqual(order, ['first', 'second', 'third'])
  })

  test('disposers run in registration order on abort()', () => {
    const lc = freshLifecycle()
    const order: string[] = []
    lc.begin('conv-1')
    lc.onDispose(() => order.push('first'))
    lc.onDispose(() => order.push('second'))
    lc.abort('userStop')
    assert.deepEqual(order, ['first', 'second'])
  })

  test('a throwing disposer does not prevent others from running', () => {
    const lc = freshLifecycle()
    const order: string[] = []
    lc.begin('conv-1')
    lc.onDispose(() => order.push('before'))
    lc.onDispose(() => {
      throw new Error('disposer failure')
    })
    lc.onDispose(() => order.push('after'))

    assert.doesNotThrow(() => lc.complete())
    assert.deepEqual(order, ['before', 'after'], 'disposer after the failing one still runs')
  })

  test('disposers are cleared after running — second complete() is a no-op', () => {
    const lc = freshLifecycle()
    let calls = 0
    lc.begin('conv-1')
    lc.onDispose(() => calls++)
    lc.complete()
    lc.complete() // second complete must not re-run disposers
    assert.equal(calls, 1)
  })
})

describe('ConversationLifecycle — abort behaviour', () => {
  test('abort() flips the AbortSignal', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    assert.equal(signal.aborted, false)
    lc.abort('userStop')
    assert.equal(signal.aborted, true)
  })

  test('abort() carries the reason to the signal', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    lc.abort('userStop')
    assert.equal(signal.reason, 'userStop')
  })

  test('abort() resets lifecycle state', () => {
    const lc = freshLifecycle()
    lc.begin('conv-1')
    lc.abort('userStop')
    assert.equal(lc.isActive, false)
    assert.equal(lc.requestId, null)
    assert.equal(lc.conversationId, null)
    assert.equal(lc.signal, null)
  })

  test('abort() forces the state machine back to idle', () => {
    const lc = freshLifecycle()
    // Drive the state machine forward so forceReset has something to reset
    conversationStateMachine.transition('sendMessage', 'conv-1')
    assert.equal(conversationStateMachine.currentState, 'chat-agent-streaming')

    lc.begin('conv-1')
    lc.abort('executionError')
    assert.equal(conversationStateMachine.currentState, 'idle')
  })

  test('abort() with no active lifecycle does not throw', () => {
    const lc = freshLifecycle()
    assert.doesNotThrow(() => lc.abort('idle'))
    assert.equal(lc.isActive, false)
  })
})

describe('ConversationLifecycle — auto-abort on supersede', () => {
  test('begin() while active auto-aborts previous lifecycle', () => {
    const lc = freshLifecycle()
    const firstSignal = lc.begin('conv-A')
    const firstRequestId = lc.requestId
    const secondSignal = lc.begin('conv-B')

    assert.equal(firstSignal.aborted, true, 'previous signal is aborted')
    assert.equal(firstSignal.reason, 'superseded')
    assert.equal(secondSignal.aborted, false, 'new signal is fresh')
    assert.equal(lc.conversationId, 'conv-B')
    assert.notEqual(lc.requestId, firstRequestId)
  })

  test('disposers from aborted lifecycle run before new begin() completes', () => {
    const lc = freshLifecycle()
    const order: string[] = []
    lc.begin('conv-A')
    lc.onDispose(() => order.push('cleanup-A'))
    lc.begin('conv-B') // triggers abort('superseded') → runs cleanup-A
    lc.onDispose(() => order.push('cleanup-B'))
    lc.complete()
    assert.deepEqual(order, ['cleanup-A', 'cleanup-B'])
  })
})

describe('ConversationLifecycle — AbortSignal interop', () => {
  test('consumers can subscribe to abort event', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    let abortedReason: unknown = null
    signal.addEventListener('abort', () => {
      abortedReason = signal.reason
    })
    lc.abort('userStop')
    assert.equal(abortedReason, 'userStop')
  })

  test('disposers see signal.aborted === true when triggered by abort()', () => {
    const lc = freshLifecycle()
    const signal = lc.begin('conv-1')
    let observedAborted: boolean | null = null
    lc.onDispose(() => {
      observedAborted = signal.aborted
    })
    lc.abort('streamError')
    assert.equal(observedAborted, true)
  })
})

// When run directly (not via run-tests.ts), print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
