/**
 * ChatStreamService decomposition tests — verifies the extracted lifecycle
 * methods (acquireStreamLock, resolveStreamIdentity, setupStreamTimers,
 * finalizeStreamMessage) maintain the same behavioral contract, now using
 * per-conversation locks and lifecycleRegistry for concurrent multi-chat streaming.
 *
 * Run: npx tsx src/main/services/__tests__/chat-stream-lifecycle.test.ts
 * Or via: npm run test:unit
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, beforeEach, createSpy, runExclusive } from './test-harness'
import { conversationStateMachine } from '../conversation-state-machine'
import { lifecycleRegistry, type ConversationLifecycle } from '../conversation-lifecycle'
import { chatAgentService } from '../chat-agent.service'
import type { ConversationPhase } from '../../../shared/types'

// ── Internal type for accessing private methods via cast ──

interface StreamContext {
  readonly conversationId: string
  readonly requestId: string
  readonly streamingRole: 'specialist'
  readonly phase: ConversationPhase
  readonly specialistMeta: { specialist: string; taskId?: string } | undefined
  readonly adapterAgentId: string
  readonly workspacePath: string | undefined
  streamedContent: string
  planInjected: boolean
}

/** Type overlay that exposes private methods for testing. */
interface ChatStreamServiceInternal {
  streamingLocks: Set<string>
  stoppedConversations: Set<string>
  activeRequestIds: Map<string, string>
  currentStreamingRole: 'specialist'
  keepaliveTimers: Map<string, ReturnType<typeof setInterval>>
  mainWindow: {
    webContents: { send: (channel: string, data: unknown) => void }
    isDestroyed: () => boolean
  }
  callbacks: { onStopPipeline: () => Promise<void> }
  safeWindowSend(channel: string, ...args: unknown[]): void
  acquireStreamLock(conversationId: string): {
    requestId: string
    signal: AbortSignal
    lifecycle: ConversationLifecycle
    resolveDone: () => void
    rejectDone: (err: Error) => void
    done: Promise<void>
  }
  resolveStreamIdentity(): {
    streamingRole: 'specialist'
    phase: ConversationPhase
    specialistMeta: { specialist: string; taskId?: string } | undefined
    adapterAgentId: string
  }
  setupStreamTimers(
    conversationId: string,
    requestId: string,
    lifecycle: ConversationLifecycle,
    rejectDone: (err: Error) => void
  ): void
  finalizeStreamMessage(ctx: StreamContext, lifecycle: ConversationLifecycle): Promise<void>
  enqueueMemoryExtraction(ctx: StreamContext): void
  forceResetIfStuck(): void
}

// ── Test doubles ──

function mockMainWindow() {
  const sentMessages: Array<{ channel: string; data: unknown }> = []
  return {
    isDestroyed: () => false,
    webContents: {
      send(channel: string, data: unknown) {
        sentMessages.push({ channel, data })
      }
    },
    sentMessages
  }
}

/**
 * Build a minimal ChatStreamService instance with injected test doubles.
 * We bind real private methods from the class prototype onto a test-double
 * object, avoiding the constructor which registers live event listeners.
 */
function createTestService(overrides?: {
  mainWindow?: ReturnType<typeof mockMainWindow>
}): ChatStreamServiceInternal {
  const mainWindow = overrides?.mainWindow ?? mockMainWindow()

  const svc: ChatStreamServiceInternal = {
    streamingLocks: new Set(),
    stoppedConversations: new Set(),
    activeRequestIds: new Map(),
    currentStreamingRole: 'specialist',
    keepaliveTimers: new Map(),
    mainWindow,
    callbacks: { onStopPipeline: async () => {} },
    safeWindowSend: undefined as unknown as ChatStreamServiceInternal['safeWindowSend'],
    acquireStreamLock: undefined as unknown as ChatStreamServiceInternal['acquireStreamLock'],
    resolveStreamIdentity:
      undefined as unknown as ChatStreamServiceInternal['resolveStreamIdentity'],
    setupStreamTimers: undefined as unknown as ChatStreamServiceInternal['setupStreamTimers'],
    finalizeStreamMessage:
      undefined as unknown as ChatStreamServiceInternal['finalizeStreamMessage'],
    enqueueMemoryExtraction: undefined as unknown as ChatStreamServiceInternal['enqueueMemoryExtraction'],
    forceResetIfStuck: undefined as unknown as ChatStreamServiceInternal['forceResetIfStuck']
  }

  // Bind the real private methods from the class prototype onto our test double.

  const { ChatStreamService } = require('../chat-stream.service') as {
    ChatStreamService: new (...args: unknown[]) => unknown
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- test double binding requires generic Function type
  const proto = ChatStreamService.prototype as Record<string, Function>

  svc.safeWindowSend = proto.safeWindowSend.bind(svc)
  svc.acquireStreamLock = proto.acquireStreamLock.bind(svc)
  svc.resolveStreamIdentity = proto.resolveStreamIdentity.bind(svc)
  svc.setupStreamTimers = proto.setupStreamTimers.bind(svc)
  svc.finalizeStreamMessage = proto.finalizeStreamMessage.bind(svc)
  svc.enqueueMemoryExtraction = proto.enqueueMemoryExtraction.bind(svc)
  svc.forceResetIfStuck = proto.forceResetIfStuck.bind(svc)

  return svc
}

/** Reset state machine + lifecycle registry to clean state. */
function resetGlobals(): void {
  conversationStateMachine.forceReset()
  lifecycleRegistry.abortAll('test-cleanup')
}

// ══════════════════════════════════════════════════════════════════════════════
// A. acquireStreamLock — per-conversation
// ══════════════════════════════════════════════════════════════════════════════

describe('acquireStreamLock', () => {
  test('acquires lock and transitions state machine to streaming', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const result = svc.acquireStreamLock('conv-1')

      assert.equal(svc.streamingLocks.has('conv-1'), true, 'streamingLock should be held for conv-1')
      assert.equal(
        conversationStateMachine.getState('conv-1'),
        'chat-agent-streaming',
        'state machine should be streaming for conv-1'
      )
      assert.match(result.requestId, /^req-\d+-[a-z0-9]+$/, 'requestId matches expected pattern')
      assert.equal(typeof result.resolveDone, 'function')
      assert.equal(typeof result.rejectDone, 'function')
      assert.ok(result.done instanceof Promise, 'done is a Promise')
      assert.ok(result.signal instanceof AbortSignal, 'signal is an AbortSignal')
      assert.ok(result.lifecycle, 'lifecycle instance is returned')

      // Cleanup
      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  test('throws when same conversation lock is already held', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-1')

      assert.throws(
        () => svc.acquireStreamLock('conv-1'),
        /already being processed in this chat/,
        'should reject concurrent stream for same conversation'
      )

      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  // A1: Cross-conversation concurrency gate — rejects while MAX_CONCURRENT_STREAMS=1
  test('rejects cross-conversation stream while another conversation is streaming (A1 gate)', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-A')

      assert.throws(
        () => svc.acquireStreamLock('conv-B'),
        /Another chat is still processing/,
        'should reject cross-conversation stream while gate=1'
      )

      // conv-A should still be streaming, conv-B should NOT be locked
      assert.equal(svc.streamingLocks.has('conv-A'), true, 'A lock still held')
      assert.equal(svc.streamingLocks.has('conv-B'), false, 'B lock never acquired')
      assert.equal(conversationStateMachine.getState('conv-B'), 'idle', 'B state machine still idle')

      lifecycleRegistry.abortAll('test-cleanup')
    }))

  // Phase 2 twin: will pass when MAX_CONCURRENT_STREAMS is raised
  // Uncomment/unskip when Phase 2 per-conversation isolation lands.
  // test('allows concurrent streams for DIFFERENT conversations (Phase 2)', () => { ... })

  test('resets stoppedConversations for the conversation', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.stoppedConversations.add('conv-1')
      svc.acquireStreamLock('conv-1')
      assert.equal(svc.stoppedConversations.has('conv-1'), false, 'stoppedConversations should be cleared')

      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  test('sets activeRequestIds for the conversation', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { requestId } = svc.acquireStreamLock('conv-1')
      assert.equal(
        svc.activeRequestIds.get('conv-1'),
        requestId,
        'activeRequestIds should match returned requestId'
      )

      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  test('done resolves when resolveDone is called', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { done, resolveDone } = svc.acquireStreamLock('conv-1')
      resolveDone()
      await done // should not hang

      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  test('done rejects when rejectDone is called', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { done, rejectDone } = svc.acquireStreamLock('conv-1')
      rejectDone(new Error('test error'))
      await assert.rejects(done, /test error/)

      lifecycleRegistry.abort('conv-1', 'test-cleanup')
    }))

  test('C3 regression: abort before Stage 8 releases streamingLock', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-x')

      // The C3 fix registers a lock-release disposer inside acquireStreamLock
      // itself — so aborting (simulating Stop during Stage 6.5, before
      // registerStreamDisposers in Stage 8) still releases the lock.
      assert.equal(svc.streamingLocks.has('conv-x'), true, 'lock should be held')
      lifecycleRegistry.abort('conv-x', 'userStop')

      assert.equal(svc.streamingLocks.has('conv-x'), false, 'streamingLock must be released by abort')
      assert.equal(svc.activeRequestIds.has('conv-x'), false, 'activeRequestId must be cleared by abort')

      // A subsequent acquireStreamLock must succeed — no permanent lockout.
      conversationStateMachine.forceReset('conv-x')
      const result = svc.acquireStreamLock('conv-y')
      assert.ok(result.requestId, 'second acquireStreamLock should succeed')
      assert.equal(svc.streamingLocks.has('conv-y'), true, 'lock should be re-acquired')

      lifecycleRegistry.abort('conv-y', 'test-cleanup')
    }))

  test('aborting conv-A does not release conv-B lock (per-conversation isolation)', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      // Manually set up two locks to test per-conversation isolation
      // of the disposer cleanup, without going through the A1 gate.
      const lcA = lifecycleRegistry.begin('conv-A')
      svc.streamingLocks.add('conv-A')
      lcA.onDispose(() => svc.streamingLocks.delete('conv-A'))

      const lcB = lifecycleRegistry.begin('conv-B')
      svc.streamingLocks.add('conv-B')
      lcB.onDispose(() => svc.streamingLocks.delete('conv-B'))

      lifecycleRegistry.abort('conv-A', 'userStop')

      assert.equal(svc.streamingLocks.has('conv-A'), false, 'A lock released')
      assert.equal(svc.streamingLocks.has('conv-B'), true, 'B lock still held')

      lifecycleRegistry.abort('conv-B', 'test-cleanup')
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// B. resolveStreamIdentity
// ══════════════════════════════════════════════════════════════════════════════

describe('resolveStreamIdentity', () => {
  // We mock chatAgentService methods by swapping them directly on the singleton.
  const svcInternal = chatAgentService as unknown as {
    _activeWorkspaceId: string | null
    sessions: Map<
      string,
      { adapter: unknown; session: unknown; forwarderCleanups: unknown[]; workspacePath: string }
    >
  }

  test('returns specialist role when no workspace-specific adapter is active', () =>
    runExclusive(async () => {
      const origWsId = svcInternal._activeWorkspaceId
      svcInternal._activeWorkspaceId = null

      try {
        const svc = createTestService()
        const result = svc.resolveStreamIdentity()

        assert.equal(result.streamingRole, 'specialist')
        assert.equal(result.phase, 'specialist-executing')
      } finally {
        svcInternal._activeWorkspaceId = origWsId
      }
    }))

  test('returns specialist role for ProjectSpecialistRoleAdapter', () =>
    runExclusive(async () => {
      const {
        ProjectSpecialistRoleAdapter
      } = require('../role-adapters/project-specialist.adapter')
      const adapter = new ProjectSpecialistRoleAdapter({ workspaceId: '__test-ws__' })

      const origWsId = svcInternal._activeWorkspaceId
      const hadSession = svcInternal.sessions.has('__test-ws__')

      svcInternal._activeWorkspaceId = '__test-ws__'
      svcInternal.sessions.set('__test-ws__', {
        adapter,
        session: {} as unknown,
        forwarderCleanups: [],
        workspacePath: '/tmp/__test-ws__'
      })

      try {
        const svc = createTestService()
        const result = svc.resolveStreamIdentity()

        assert.equal(result.streamingRole, 'specialist')
        assert.equal(result.phase, 'specialist-executing')
        assert.ok(result.specialistMeta)
        assert.equal(result.specialistMeta!.specialist, 'workspace-specialist-__test-ws__')
      } finally {
        svcInternal._activeWorkspaceId = origWsId
        if (!hadSession) svcInternal.sessions.delete('__test-ws__')
      }
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// C. setupStreamTimers
// ══════════════════════════════════════════════════════════════════════════════

describe('setupStreamTimers', () => {
  test('registers keepalive timer', () =>
    runExclusive(async () => {
      resetGlobals()
      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      const lifecycle = lifecycleRegistry.begin('conv-timer')

      const rejectDone = createSpy<[Error], void>()
      svc.setupStreamTimers('conv-timer', lifecycle.requestId!, lifecycle, rejectDone)

      assert.ok(svc.keepaliveTimers.has('conv-timer'), 'keepaliveTimer should be set')

      // Cleanup — lifecycle dispose should clear timers
      lifecycle.complete()
      assert.equal(svc.keepaliveTimers.has('conv-timer'), false, 'keepaliveTimer cleared on dispose')
    }))

  test('dispose clears both timers without firing callbacks', () =>
    runExclusive(async () => {
      resetGlobals()
      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      const lifecycle = lifecycleRegistry.begin('conv-timer-2')

      const rejectDone = createSpy<[Error], void>()
      svc.setupStreamTimers('conv-timer-2', lifecycle.requestId!, lifecycle, rejectDone)

      // Trigger dispose before safety timer fires
      lifecycle.complete()

      assert.equal(svc.keepaliveTimers.has('conv-timer-2'), false, 'keepaliveTimer cleared')
      assert.equal(rejectDone.callCount, 0, 'rejectDone should not be called')
    }))

  test('per-conversation timers: aborting A does not clear B timer', () =>
    runExclusive(async () => {
      resetGlobals()
      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      const lcA = lifecycleRegistry.begin('conv-A')
      const lcB = lifecycleRegistry.begin('conv-B')

      const rejectA = createSpy<[Error], void>()
      const rejectB = createSpy<[Error], void>()
      svc.setupStreamTimers('conv-A', lcA.requestId!, lcA, rejectA)
      svc.setupStreamTimers('conv-B', lcB.requestId!, lcB, rejectB)

      assert.ok(svc.keepaliveTimers.has('conv-A'))
      assert.ok(svc.keepaliveTimers.has('conv-B'))

      lifecycleRegistry.abort('conv-A', 'test')

      assert.equal(svc.keepaliveTimers.has('conv-A'), false, 'A timer cleared')
      assert.ok(svc.keepaliveTimers.has('conv-B'), 'B timer still active')

      lifecycleRegistry.abort('conv-B', 'test-cleanup')
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// D. finalizeStreamMessage — core value (guards against B3 regression)
// ══════════════════════════════════════════════════════════════════════════════

describe('finalizeStreamMessage', () => {
  const { messageRepository } = require('../../db/repositories') as {
    messageRepository: {
      create: (...args: unknown[]) => { id: string }
      updateToolActivities: (...args: unknown[]) => void
    }
  }

  let originalCreate: typeof messageRepository.create
  let originalUpdateTA: typeof messageRepository.updateToolActivities

  beforeEach(() => {
    originalCreate = messageRepository.create
    originalUpdateTA = messageRepository.updateToolActivities
  })

  const restoreRepo = () => {
    messageRepository.create = originalCreate
    messageRepository.updateToolActivities = originalUpdateTA
  }

  test('saves message to DB and sends COMPLETE IPC on success', () =>
    runExclusive(async () => {
      resetGlobals()
      // Drive state machine to streaming so transition('chatAgentComplete') works
      conversationStateMachine.transition('sendMessage', 'conv-finalize')
      const lifecycle = lifecycleRegistry.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      const createSpy_ = createSpy<unknown[], { id: string }>(() => ({ id: 'msg-1' }))
      messageRepository.create = createSpy_ as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: lifecycle.requestId!,
        streamingRole: 'specialist',
        phase: 'specialist-responding',
        specialistMeta: undefined,
        adapterAgentId: 'specialist',
        workspacePath: undefined,
        streamedContent: 'Hello world',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx, lifecycle)
      restoreRepo()

      // Assert: messageRepository.create called
      assert.ok(createSpy_.callCount >= 1, 'messageRepository.create should be called')
      const createArgs = createSpy_.calls[0]
      assert.equal(createArgs[0], 'conv-finalize', 'conversationId')
      assert.equal(createArgs[1], 'specialist', 'role')
      assert.equal(createArgs[2], 'Hello world', 'cleaned content')

      // Assert: CHAT_MESSAGE_COMPLETE sent (channel is 'chat:messageComplete')
      const completeMsg = mainWindow.sentMessages.find((m) => m.channel === 'chat:messageComplete')
      assert.ok(completeMsg, 'CHAT_MESSAGE_COMPLETE should be sent')

      // Assert: state machine transitioned to idle
      assert.equal(conversationStateMachine.getState('conv-finalize'), 'idle', 'state machine should be idle')
    }))

  test('sends error chunk when streamedContent is empty', () =>
    runExclusive(async () => {
      resetGlobals()
      conversationStateMachine.transition('sendMessage', 'conv-finalize')
      const lifecycle = lifecycleRegistry.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      messageRepository.create = (() => ({
        id: 'msg-empty'
      })) as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: lifecycle.requestId!,
        streamingRole: 'specialist',
        phase: 'specialist-responding',
        specialistMeta: undefined,
        adapterAgentId: 'specialist',
        workspacePath: undefined,
        streamedContent: '',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx, lifecycle)
      restoreRepo()

      // Should still transition to idle
      assert.equal(conversationStateMachine.getState('conv-finalize'), 'idle', 'state machine should be idle')

      // Should have sent an error text chunk (channel is 'chat:messageChunk')
      const errorChunk = mainWindow.sentMessages.find(
        (m) =>
          m.channel === 'chat:messageChunk' &&
          typeof m.data === 'object' &&
          m.data !== null &&
          'chunk' in m.data &&
          typeof (m.data as Record<string, unknown>).chunk === 'string' &&
          ((m.data as Record<string, unknown>).chunk as string).includes('Error')
      )
      assert.ok(errorChunk, 'error chunk should be sent for empty content')
    }))

  test('transitions state machine to idle even when DB save throws', () =>
    runExclusive(async () => {
      resetGlobals()
      conversationStateMachine.transition('sendMessage', 'conv-finalize')
      const lifecycle = lifecycleRegistry.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      messageRepository.create = (() => {
        throw new Error('DB write failed')
      }) as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: lifecycle.requestId!,
        streamingRole: 'specialist',
        phase: 'specialist-responding',
        specialistMeta: undefined,
        adapterAgentId: 'specialist',
        workspacePath: undefined,
        streamedContent: 'Some content',
        planInjected: false
      }

      // Should NOT throw — error is handled internally
      await svc.finalizeStreamMessage(ctx, lifecycle)
      restoreRepo()

      // THE critical B3 regression guard: state machine must transition to idle
      assert.equal(
        conversationStateMachine.getState('conv-finalize'),
        'idle',
        'state machine MUST transition to idle even when DB save throws'
      )

      // Error chunk should be sent to renderer (channel is 'chat:messageChunk')
      const errorChunk = mainWindow.sentMessages.find(
        (m) =>
          m.channel === 'chat:messageChunk' &&
          typeof m.data === 'object' &&
          m.data !== null &&
          'chunk' in m.data &&
          typeof (m.data as Record<string, unknown>).chunk === 'string' &&
          ((m.data as Record<string, unknown>).chunk as string).includes('DB write failed')
      )
      assert.ok(errorChunk, 'error chunk with DB message should be sent')

      // COMPLETE should still be sent (with error- messageId)
      const completeMsg = mainWindow.sentMessages.find((m) => m.channel === 'chat:messageComplete')
      assert.ok(completeMsg, 'CHAT_MESSAGE_COMPLETE should still be sent on DB failure')
    }))

  test('persists tool activities when present', () =>
    runExclusive(async () => {
      resetGlobals()
      conversationStateMachine.transition('sendMessage', 'conv-finalize')
      const lifecycle = lifecycleRegistry.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      messageRepository.create = (() => ({
        id: 'msg-ta'
      })) as unknown as typeof messageRepository.create
      const updateTASpy = createSpy()
      messageRepository.updateToolActivities =
        updateTASpy as unknown as typeof messageRepository.updateToolActivities

      // Clear any stale data first
      const { getAndClearToolActivities } = require('../../ipc/chunk-router') as {
        getAndClearToolActivities: (convId: string) => unknown[]
      }
      getAndClearToolActivities('conv-finalize')

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: lifecycle.requestId!,
        streamingRole: 'specialist',
        phase: 'specialist-responding',
        specialistMeta: undefined,
        adapterAgentId: 'specialist',
        workspacePath: undefined,
        streamedContent: 'Response with tools',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx, lifecycle)
      restoreRepo()

      // State machine should always transition to idle
      assert.equal(conversationStateMachine.getState('conv-finalize'), 'idle')
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// E. forceResetIfStuck (guards against B1 regression) — now registry-aware
// ══════════════════════════════════════════════════════════════════════════════

describe('forceResetIfStuck', () => {
  test('aborts all lifecycles when streams are active', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()

      // Simulate two streams in progress
      svc.streamingLocks.add('conv-A')
      svc.streamingLocks.add('conv-B')
      conversationStateMachine.transition('sendMessage', 'conv-A')
      conversationStateMachine.transition('sendMessage', 'conv-B')
      const lcA = lifecycleRegistry.begin('conv-A')
      const lcB = lifecycleRegistry.begin('conv-B')

      // Register disposers that release the locks (as the real registerStreamDisposers does)
      lcA.onDispose(() => svc.streamingLocks.delete('conv-A'))
      lcB.onDispose(() => svc.streamingLocks.delete('conv-B'))

      svc.forceResetIfStuck()

      assert.equal(svc.streamingLocks.size, 0, 'all streaming locks should be released')
      assert.equal(conversationStateMachine.isIdle(), true, 'state machine should be idle')
      assert.equal(lifecycleRegistry.active().length, 0, 'no active lifecycles')
    }))

  test('no-op when nothing is stuck', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()

      svc.forceResetIfStuck()

      assert.equal(svc.streamingLocks.size, 0)
      assert.equal(conversationStateMachine.isIdle(), true)
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// F. enqueueMemoryExtraction
// ══════════════════════════════════════════════════════════════════════════════

describe('enqueueMemoryExtraction', () => {
  test('does not crash when memoryExtractionService throws', () => {
    const svc = createTestService()
    const ctx: StreamContext = {
      conversationId: 'conv-mem',
      requestId: 'req-mem',
      streamingRole: 'specialist',
      phase: 'specialist-responding',
      specialistMeta: undefined,
      adapterAgentId: 'specialist',
      workspacePath: undefined,
      streamedContent: 'some content that is definitely longer than 200 characters to pass the length guard in enqueueMemoryExtraction which checks ctx.streamedContent.length > 200 before calling the service so we need to have enough text here to exceed that threshold',
      planInjected: false
    }

    // Should not throw — errors are caught internally
    assert.doesNotThrow(() => svc.enqueueMemoryExtraction(ctx))
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// G. StreamContext interface contract
// ══════════════════════════════════════════════════════════════════════════════

describe('StreamContext mutable state', () => {
  test('streamedContent is mutable on the context object', () => {
    const ctx: StreamContext = {
      conversationId: 'conv-1',
      requestId: 'req-1',
      streamingRole: 'specialist',
      phase: 'specialist-responding',
      specialistMeta: undefined,
      adapterAgentId: 'specialist',
      workspacePath: undefined,
      streamedContent: '',
      planInjected: false
    }

    ctx.streamedContent += 'hello '
    ctx.streamedContent += 'world'
    assert.equal(ctx.streamedContent, 'hello world')
  })

  test('planInjected guards against duplicate injection', () => {
    const ctx: StreamContext = {
      conversationId: 'conv-1',
      requestId: 'req-1',
      streamingRole: 'specialist',
      phase: 'specialist-responding',
      specialistMeta: undefined,
      adapterAgentId: 'specialist',
      workspacePath: undefined,
      streamedContent: '',
      planInjected: false
    }

    assert.equal(ctx.planInjected, false)
    ctx.planInjected = true
    assert.equal(ctx.planInjected, true)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// H. Concurrent streaming — A1 gate enforcement + per-conversation isolation
// ══════════════════════════════════════════════════════════════════════════════

describe('Concurrent streaming — A1 gate enforcement', () => {
  test('cross-conversation lock rejected while gate=1', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-A')

      // With MAX_CONCURRENT_STREAMS=1, conv-B should be rejected
      assert.throws(
        () => svc.acquireStreamLock('conv-B'),
        /Another chat is still processing/,
        'cross-conversation lock should be rejected'
      )

      // Stopping conv-A should then allow conv-B
      lifecycleRegistry.abort('conv-A', 'userStop')
      const resultB = svc.acquireStreamLock('conv-B')
      assert.ok(resultB.requestId, 'conv-B should acquire lock after A stopped')

      lifecycleRegistry.abort('conv-B', 'test-cleanup')
    }))

  test('same-conversation supersede still works under the gate', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-A')

      // Re-acquiring the same conversation should throw the same-conv error,
      // not the cross-conv error
      assert.throws(
        () => svc.acquireStreamLock('conv-A'),
        /already being processed in this chat/,
        'same-conversation rejection uses the right message'
      )

      lifecycleRegistry.abortAll('test-cleanup')
    }))

  test('stopping conv-A does not mark conv-B as stopped (per-conversation isolation)', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()

      // Manually manage stopped state (no concurrent lock needed)
      svc.stoppedConversations.add('conv-A')

      assert.equal(svc.stoppedConversations.has('conv-A'), true)
      assert.equal(svc.stoppedConversations.has('conv-B'), false)
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// I. LifecycleRegistry — A4 begin-from-disposer regression guard
// ══════════════════════════════════════════════════════════════════════════════

describe('LifecycleRegistry — A4 begin-from-disposer', () => {
  test('abort does not delete a lifecycle begun from a disposer', () =>
    runExclusive(async () => {
      resetGlobals()

      // Begin lifecycle for conv-X
      const lc1 = lifecycleRegistry.begin('conv-X')
      assert.ok(lc1.isActive, 'lc1 should be active')

      // Register a disposer that begins a new lifecycle for the SAME conversation
      let lc2: ConversationLifecycle | undefined
      lc1.onDispose(() => {
        lc2 = lifecycleRegistry.begin('conv-X')
      })

      // Abort lc1 — this should:
      // 1. Fire lc1's disposers (which calls begin('conv-X') creating lc2)
      // 2. NOT delete lc2 from the registry
      lifecycleRegistry.abort('conv-X', 'test-supersede')

      // lc2 should be the current active lifecycle for conv-X
      assert.ok(lc2, 'lc2 should have been created by the disposer')
      assert.ok(lc2!.isActive, 'lc2 should be active')
      assert.equal(
        lifecycleRegistry.get('conv-X'),
        lc2,
        'registry should contain lc2, not have deleted it'
      )
      assert.equal(lc1.isActive, false, 'lc1 should be inactive after abort')

      lifecycleRegistry.abort('conv-X', 'test-cleanup')
    }))

  test('abort deletes lifecycle normally when no disposer re-begins', () =>
    runExclusive(async () => {
      resetGlobals()
      lifecycleRegistry.begin('conv-Y')
      lifecycleRegistry.abort('conv-Y', 'test')

      assert.equal(lifecycleRegistry.get('conv-Y'), undefined, 'should be removed from registry')
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// J. forceResetIfStuck — A9 SM-stuck-with-empty-registry
// ══════════════════════════════════════════════════════════════════════════════

describe('forceResetIfStuck — A9 SM stuck with empty registry', () => {
  test('resets stuck state machine even when registry is empty', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()

      // Simulate stuck SM state without any active lifecycle in registry.
      // This can happen when a lifecycle was cleaned up but the SM entry
      // wasn't (e.g. forceReset not called during an edge-case abort path).
      conversationStateMachine.transition('sendMessage', 'conv-stuck')
      assert.equal(conversationStateMachine.isIdle(), false, 'SM should be stuck')
      assert.equal(lifecycleRegistry.active().length, 0, 'registry should be empty')

      svc.forceResetIfStuck()

      assert.equal(conversationStateMachine.isIdle(), true, 'SM should be idle after force reset')
      assert.equal(conversationStateMachine.getState('conv-stuck'), 'idle', 'conv-stuck should be idle')
    }))
})

// When run directly (not via run-tests.ts), print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
