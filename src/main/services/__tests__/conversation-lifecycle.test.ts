/**
 * ConversationLifecycle + LifecycleRegistry tests — verifies the per-conversation
 * lifecycle manager and the registry that enables concurrent multi-chat streaming.
 *
 * The `ConversationLifecycle` class is tested as instances (one per stream).
 * The `LifecycleRegistry` is tested for concurrent stream management, independent
 * abort, and abortAll behavior.
 *
 * Kept synchronous so `run-tests.ts` style execution works without summaryAsync().
 *
 * Run: tsx src/main/services/__tests__/conversation-lifecycle.test.ts
 * Or via: npm run test:unit
 */

import assert from 'node:assert/strict'
import { ConversationLifecycle, LifecycleRegistry } from '../conversation-lifecycle'
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

/** Build a fresh registry for each test. */
function freshRegistry(): LifecycleRegistry {
  conversationStateMachine.forceReset()
  return new LifecycleRegistry()
}

// ══════════════════════════════════════════════════════════════════════════════
// A. ConversationLifecycle — begin/complete basics
// ══════════════════════════════════════════════════════════════════════════════

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
    assert.match(lc.requestId!, /^req-\d+-[a-z0-9]{4}$/)
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

// ══════════════════════════════════════════════════════════════════════════════
// B. ConversationLifecycle — disposer contract
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// C. ConversationLifecycle — abort behaviour
// ══════════════════════════════════════════════════════════════════════════════

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

  test('abort() forces the state machine back to idle for that conversation', () => {
    const lc = freshLifecycle()
    // Drive the state machine forward so forceReset has something to reset
    conversationStateMachine.transition('sendMessage', 'conv-1')
    assert.equal(conversationStateMachine.getState('conv-1'), 'chat-agent-streaming')

    lc.begin('conv-1')
    lc.abort('executionError')
    assert.equal(conversationStateMachine.getState('conv-1'), 'idle')
  })

  test('abort() with no active lifecycle does not throw', () => {
    const lc = freshLifecycle()
    assert.doesNotThrow(() => lc.abort('idle'))
    assert.equal(lc.isActive, false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// D. ConversationLifecycle — auto-abort on supersede
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// E. ConversationLifecycle — AbortSignal interop
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// F. LifecycleRegistry — concurrent multi-chat streaming
// ══════════════════════════════════════════════════════════════════════════════

describe('LifecycleRegistry — basic operations', () => {
  test('begin() creates a lifecycle for a conversation', () => {
    const registry = freshRegistry()
    const lc = registry.begin('conv-A')
    assert.equal(lc.isActive, true)
    assert.equal(lc.conversationId, 'conv-A')
    assert.notEqual(lc.requestId, null)
  })

  test('get() returns the lifecycle for an active conversation', () => {
    const registry = freshRegistry()
    const lc = registry.begin('conv-A')
    const got = registry.get('conv-A')
    assert.equal(got, lc)
  })

  test('get() returns undefined for unknown conversation', () => {
    const registry = freshRegistry()
    assert.equal(registry.get('conv-unknown'), undefined)
  })

  test('isStreaming() returns true for active conversations', () => {
    const registry = freshRegistry()
    registry.begin('conv-A')
    assert.equal(registry.isStreaming('conv-A'), true)
    assert.equal(registry.isStreaming('conv-B'), false)
  })

  test('size reflects active stream count', () => {
    const registry = freshRegistry()
    assert.equal(registry.size, 0)
    registry.begin('conv-A')
    assert.equal(registry.size, 1)
    registry.begin('conv-B')
    assert.equal(registry.size, 2)
  })
})

describe('LifecycleRegistry — concurrent streams', () => {
  test('two conversations can stream concurrently', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')

    assert.equal(lcA.isActive, true)
    assert.equal(lcB.isActive, true)
    assert.notEqual(lcA.requestId, lcB.requestId)
    assert.equal(registry.size, 2)
    assert.deepEqual(
      registry
        .active()
        .map((s) => s.conversationId)
        .sort(),
      ['conv-A', 'conv-B']
    )
  })

  test('aborting one stream does not affect the other', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')
    const signalB = lcB.signal!

    registry.abort('conv-A', 'userStop')

    assert.equal(lcA.isActive, false, 'A should be aborted')
    assert.equal(lcB.isActive, true, 'B should still be active')
    assert.equal(signalB.aborted, false, 'B signal should not be aborted')
    assert.equal(registry.size, 1)
    assert.equal(registry.isStreaming('conv-A'), false)
    assert.equal(registry.isStreaming('conv-B'), true)
  })

  test('completing one stream does not affect the other', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')

    lcA.complete()

    assert.equal(lcA.isActive, false, 'A should be completed')
    assert.equal(lcB.isActive, true, 'B should still be active')
    assert.equal(registry.size, 1)
  })

  test('disposers from one stream do not fire on the other', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')

    let aDisposed = false
    let bDisposed = false
    lcA.onDispose(() => {
      aDisposed = true
    })
    lcB.onDispose(() => {
      bDisposed = true
    })

    registry.abort('conv-A', 'userStop')

    assert.equal(aDisposed, true, 'A disposers should run')
    assert.equal(bDisposed, false, 'B disposers should NOT run')
  })
})

describe('LifecycleRegistry — abortAll', () => {
  test('abortAll aborts every active lifecycle', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')
    const lcC = registry.begin('conv-C')

    registry.abortAll('workspace-switch')

    assert.equal(lcA.isActive, false)
    assert.equal(lcB.isActive, false)
    assert.equal(lcC.isActive, false)
    assert.equal(registry.size, 0)
    assert.deepEqual(registry.active(), [])
  })

  test('abortAll runs disposers for all lifecycles', () => {
    const registry = freshRegistry()
    const lcA = registry.begin('conv-A')
    const lcB = registry.begin('conv-B')

    const disposed: string[] = []
    lcA.onDispose(() => disposed.push('A'))
    lcB.onDispose(() => disposed.push('B'))

    registry.abortAll('test')

    assert.equal(disposed.length, 2)
    assert.ok(disposed.includes('A'))
    assert.ok(disposed.includes('B'))
  })
})

describe('LifecycleRegistry — supersede same conversation', () => {
  test('begin() for same conversation supersedes previous lifecycle', () => {
    const registry = freshRegistry()
    const lc1 = registry.begin('conv-A')
    const signal1 = lc1.signal!
    const lc2 = registry.begin('conv-A')

    assert.equal(signal1.aborted, true, 'first lifecycle should be aborted')
    assert.equal(lc2.isActive, true, 'second lifecycle should be active')
    assert.equal(registry.size, 1, 'only one lifecycle should exist')
  })
})

describe('LifecycleRegistry — auto-cleanup on complete', () => {
  test('lifecycle is removed from registry after complete()', () => {
    const registry = freshRegistry()
    const lc = registry.begin('conv-A')
    assert.equal(registry.size, 1)

    lc.complete()

    assert.equal(registry.size, 0)
    assert.equal(registry.get('conv-A'), undefined)
  })

  test('lifecycle is removed from registry after abort()', () => {
    const registry = freshRegistry()
    registry.begin('conv-A')
    assert.equal(registry.size, 1)

    registry.abort('conv-A', 'test')

    assert.equal(registry.size, 0)
    assert.equal(registry.get('conv-A'), undefined)
  })
})

// When run directly (not via run-tests.ts), print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
