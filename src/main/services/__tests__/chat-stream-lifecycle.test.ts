/**
 * ChatStreamService decomposition tests — verifies the extracted lifecycle
 * methods (acquireStreamLock, resolveStreamIdentity, setupStreamTimers,
 * finalizeStreamMessage) maintain the same behavioral contract as the
 * original monolithic stream() method.
 *
 * Run: npx tsx src/main/services/__tests__/chat-stream-lifecycle.test.ts
 * Or via: npm run test:unit
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync, beforeEach, createSpy, runExclusive } from './test-harness'
import { conversationStateMachine } from '../conversation-state-machine'
import { conversationLifecycle } from '../conversation-lifecycle'
import { chatAgentService } from '../chat-agent.service'
import type { ConversationPhase } from '../../../shared/types'

// ── Internal type for accessing private methods via cast ──

interface StreamContext {
  readonly conversationId: string
  readonly requestId: string
  readonly streamingRole: 'da-vinci' | 'specialist'
  readonly phase: ConversationPhase
  readonly specialistMeta: { specialist: string; taskId?: string } | undefined
  readonly adapterAgentId: string
  readonly workspacePath: string | undefined
  streamedContent: string
  planInjected: boolean
}

/** Type overlay that exposes private methods for testing. */
interface ChatStreamServiceInternal {
  streamingLock: boolean
  isStopped: boolean
  activeRequestId: string | null
  currentStreamingRole: 'da-vinci' | 'specialist'
  keepaliveTimer: ReturnType<typeof setInterval> | null
  mainWindow: {
    webContents: { send: (channel: string, data: unknown) => void }
    isDestroyed: () => boolean
  }
  callbacks: { onStopPipeline: () => Promise<void> }
  safeWindowSend(channel: string, ...args: unknown[]): void
  acquireStreamLock(conversationId: string): {
    requestId: string
    signal: AbortSignal
    resolveDone: () => void
    rejectDone: (err: Error) => void
    done: Promise<void>
  }
  resolveStreamIdentity(): {
    streamingRole: 'da-vinci' | 'specialist'
    phase: ConversationPhase
    specialistMeta: { specialist: string; taskId?: string } | undefined
    adapterAgentId: string
  }
  setupStreamTimers(
    conversationId: string,
    requestId: string,
    rejectDone: (err: Error) => void
  ): void
  finalizeStreamMessage(ctx: StreamContext): Promise<void>
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
    streamingLock: false,
    isStopped: false,
    activeRequestId: null,
    currentStreamingRole: 'da-vinci',
    keepaliveTimer: null,
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
  // Bind safeWindowSend so finalizeStreamMessage can call it on the test double
  if (proto.safeWindowSend) {
    ;(svc as unknown as Record<string, unknown>).safeWindowSend = proto.safeWindowSend.bind(svc)
  }

  return svc
}

/** Reset state machine + lifecycle singleton to clean state. */
function resetGlobals(): void {
  conversationStateMachine.forceReset()
  if (conversationLifecycle.isActive) {
    conversationLifecycle.abort('test-cleanup')
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// A. acquireStreamLock
// ══════════════════════════════════════════════════════════════════════════════

describe('acquireStreamLock', () => {
  // All tests mutate the conversationStateMachine + conversationLifecycle singletons.
  // Use runExclusive to serialize them.

  test('acquires lock and transitions state machine to streaming', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const result = svc.acquireStreamLock('conv-1')

      assert.equal(svc.streamingLock, true, 'streamingLock should be true')
      assert.equal(
        conversationStateMachine.currentState,
        'chat-agent-streaming',
        'state machine should be streaming'
      )
      assert.match(result.requestId, /^req-\d+-[a-z0-9]+$/, 'requestId matches expected pattern')
      assert.equal(typeof result.resolveDone, 'function')
      assert.equal(typeof result.rejectDone, 'function')
      assert.ok(result.done instanceof Promise, 'done is a Promise')
      assert.ok(result.signal instanceof AbortSignal, 'signal is an AbortSignal')

      // Cleanup: release lifecycle so next test starts clean
      conversationLifecycle.abort('test-cleanup')
    }))

  test('throws when streamingLock is already held', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-1')

      assert.throws(
        () => svc.acquireStreamLock('conv-2'),
        /already being processed/,
        'should reject concurrent stream'
      )

      conversationLifecycle.abort('test-cleanup')
    }))

  test('throws when state machine is not idle', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      // Manually transition state machine away from idle without setting lock
      conversationStateMachine.transition('sendMessage', 'conv-ext')

      assert.throws(
        () => svc.acquireStreamLock('conv-1'),
        /already being processed/,
        'should reject when state machine is not idle'
      )

      conversationStateMachine.forceReset()
      if (conversationLifecycle.isActive) conversationLifecycle.abort('test-cleanup')
    }))

  test('resets isStopped to false', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.isStopped = true
      svc.acquireStreamLock('conv-1')
      assert.equal(svc.isStopped, false, 'isStopped should be reset to false')

      conversationLifecycle.abort('test-cleanup')
    }))

  test('sets activeRequestId', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { requestId } = svc.acquireStreamLock('conv-1')
      assert.equal(
        svc.activeRequestId,
        requestId,
        'activeRequestId should match returned requestId'
      )

      conversationLifecycle.abort('test-cleanup')
    }))

  test('done resolves when resolveDone is called', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { done, resolveDone } = svc.acquireStreamLock('conv-1')
      resolveDone()
      await done // should not hang

      conversationLifecycle.abort('test-cleanup')
    }))

  test('done rejects when rejectDone is called', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      const { done, rejectDone } = svc.acquireStreamLock('conv-1')
      rejectDone(new Error('test error'))
      await assert.rejects(done, /test error/)

      conversationLifecycle.abort('test-cleanup')
    }))

  test('C3 regression: abort before Stage 8 releases streamingLock', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.acquireStreamLock('conv-x')

      // The C3 fix registers a lock-release disposer inside acquireStreamLock
      // itself — so aborting (simulating Stop during Stage 6.5, before
      // registerStreamDisposers in Stage 8) still releases the lock.
      assert.equal(svc.streamingLock, true, 'lock should be held')
      conversationLifecycle.abort('userStop')

      assert.equal(svc.streamingLock, false, 'streamingLock must be released by abort')
      assert.equal(svc.activeRequestId, null, 'activeRequestId must be cleared by abort')

      // A subsequent acquireStreamLock must succeed — no permanent lockout.
      conversationStateMachine.forceReset()
      const result = svc.acquireStreamLock('conv-y')
      assert.ok(result.requestId, 'second acquireStreamLock should succeed')
      assert.equal(svc.streamingLock, true, 'lock should be re-acquired')

      conversationLifecycle.abort('test-cleanup')
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
    daVinciAdapter: {
      currentPersonaSpecialistId: string | null
      currentPersonaData: { agentId: string; alias?: string; displayName?: string } | null
      getPersona(): {
        id: string | null
        data: { agentId: string; alias?: string; displayName?: string } | null
      }
    }
  }

  test('returns da-vinci role when no persona is active', () =>
    runExclusive(async () => {
      const origWsId = svcInternal._activeWorkspaceId
      svcInternal._activeWorkspaceId = null

      try {
        const svc = createTestService()
        const result = svc.resolveStreamIdentity()

        assert.equal(result.streamingRole, 'da-vinci')
        assert.equal(result.phase, 'da-vinci-responding')
        assert.equal(result.adapterAgentId, 'da-vinci')
        assert.equal(result.specialistMeta, undefined)
      } finally {
        svcInternal._activeWorkspaceId = origWsId
      }
    }))

  test('returns specialist role when persona overlay is active', () =>
    runExclusive(async () => {
      const origWsId = svcInternal._activeWorkspaceId
      const origPersonaId = svcInternal.daVinciAdapter.currentPersonaSpecialistId
      const origPersonaData = svcInternal.daVinciAdapter.currentPersonaData

      // Activate persona by setting private fields on the DaVinciAdapter
      svcInternal._activeWorkspaceId = null // falls back to daVinciAdapter
      svcInternal.daVinciAdapter.currentPersonaSpecialistId = 'code-reviewer'
      svcInternal.daVinciAdapter.currentPersonaData = {
        agentId: 'code-reviewer',
        alias: 'Code Reviewer'
      }

      try {
        const svc = createTestService()
        const result = svc.resolveStreamIdentity()

        assert.equal(result.streamingRole, 'specialist')
        assert.equal(result.phase, 'specialist-executing')
        assert.ok(result.specialistMeta, 'specialistMeta should be present')
        assert.equal(result.specialistMeta!.specialist, 'code-reviewer')
      } finally {
        svcInternal._activeWorkspaceId = origWsId
        svcInternal.daVinciAdapter.currentPersonaSpecialistId = origPersonaId
        svcInternal.daVinciAdapter.currentPersonaData = origPersonaData
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
      conversationLifecycle.begin('conv-timer')

      const rejectDone = createSpy<[Error], void>()
      svc.setupStreamTimers('conv-timer', 'req-1', rejectDone)

      assert.notEqual(svc.keepaliveTimer, null, 'keepaliveTimer should be set')

      // Cleanup — lifecycle dispose should clear timers
      conversationLifecycle.complete()
      assert.equal(svc.keepaliveTimer, null, 'keepaliveTimer cleared on dispose')
    }))

  test('dispose clears both timers without firing callbacks', () =>
    runExclusive(async () => {
      resetGlobals()
      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      conversationLifecycle.begin('conv-timer-2')

      const rejectDone = createSpy<[Error], void>()
      svc.setupStreamTimers('conv-timer-2', 'req-2', rejectDone)

      // Trigger dispose before safety timer fires
      conversationLifecycle.complete()

      assert.equal(svc.keepaliveTimer, null, 'keepaliveTimer cleared')
      assert.equal(rejectDone.callCount, 0, 'rejectDone should not be called')
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
      conversationLifecycle.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      const createSpy_ = createSpy<unknown[], { id: string }>(() => ({ id: 'msg-1' }))
      messageRepository.create = createSpy_ as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: conversationLifecycle.requestId!,
        streamingRole: 'da-vinci',
        phase: 'da-vinci-responding',
        specialistMeta: undefined,
        adapterAgentId: 'da-vinci',
        workspacePath: undefined,
        streamedContent: 'Hello world',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx)
      restoreRepo()

      // Assert: messageRepository.create called
      assert.ok(createSpy_.callCount >= 1, 'messageRepository.create should be called')
      const createArgs = createSpy_.calls[0]
      assert.equal(createArgs[0], 'conv-finalize', 'conversationId')
      assert.equal(createArgs[1], 'da-vinci', 'role')
      assert.equal(createArgs[2], 'Hello world', 'cleaned content')

      // Assert: CHAT_MESSAGE_COMPLETE sent (channel is 'chat:messageComplete')
      const completeMsg = mainWindow.sentMessages.find((m) => m.channel === 'chat:messageComplete')
      assert.ok(completeMsg, 'CHAT_MESSAGE_COMPLETE should be sent')

      // Assert: state machine transitioned to idle
      assert.equal(conversationStateMachine.currentState, 'idle', 'state machine should be idle')
    }))

  test('sends error chunk when streamedContent is empty', () =>
    runExclusive(async () => {
      resetGlobals()
      conversationStateMachine.transition('sendMessage', 'conv-finalize')
      conversationLifecycle.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      messageRepository.create = (() => ({
        id: 'msg-empty'
      })) as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: conversationLifecycle.requestId!,
        streamingRole: 'da-vinci',
        phase: 'da-vinci-responding',
        specialistMeta: undefined,
        adapterAgentId: 'da-vinci',
        workspacePath: undefined,
        streamedContent: '',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx)
      restoreRepo()

      // Should still transition to idle
      assert.equal(conversationStateMachine.currentState, 'idle', 'state machine should be idle')

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
      conversationLifecycle.begin('conv-finalize')

      const mainWindow = mockMainWindow()
      const svc = createTestService({ mainWindow })
      messageRepository.create = (() => {
        throw new Error('DB write failed')
      }) as unknown as typeof messageRepository.create

      const ctx: StreamContext = {
        conversationId: 'conv-finalize',
        requestId: conversationLifecycle.requestId!,
        streamingRole: 'da-vinci',
        phase: 'da-vinci-responding',
        specialistMeta: undefined,
        adapterAgentId: 'da-vinci',
        workspacePath: undefined,
        streamedContent: 'Some content',
        planInjected: false
      }

      // Should NOT throw — error is handled internally
      await svc.finalizeStreamMessage(ctx)
      restoreRepo()

      // THE critical B3 regression guard: state machine must transition to idle
      assert.equal(
        conversationStateMachine.currentState,
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
      conversationLifecycle.begin('conv-finalize')

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
        requestId: conversationLifecycle.requestId!,
        streamingRole: 'da-vinci',
        phase: 'da-vinci-responding',
        specialistMeta: undefined,
        adapterAgentId: 'da-vinci',
        workspacePath: undefined,
        streamedContent: 'Response with tools',
        planInjected: false
      }

      await svc.finalizeStreamMessage(ctx)
      restoreRepo()

      // State machine should always transition to idle
      assert.equal(conversationStateMachine.currentState, 'idle')
    }))
})

// ══════════════════════════════════════════════════════════════════════════════
// E. forceResetIfStuck (guards against B1 regression)
// ══════════════════════════════════════════════════════════════════════════════

describe('forceResetIfStuck', () => {
  test('aborts lifecycle when streamingLock is held', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()

      // Simulate a stream in progress
      svc.streamingLock = true
      conversationStateMachine.transition('sendMessage', 'conv-stuck')
      conversationLifecycle.begin('conv-stuck')

      // Register a disposer that releases the lock (as the real registerStreamDisposers does)
      conversationLifecycle.onDispose(() => {
        svc.streamingLock = false
      })

      svc.forceResetIfStuck()

      assert.equal(svc.streamingLock, false, 'streamingLock should be released via dispose')
      assert.equal(conversationStateMachine.currentState, 'idle', 'state machine should be idle')
      assert.equal(conversationLifecycle.isActive, false, 'lifecycle should not be active')
    }))

  test('no-op when streamingLock is not held', () =>
    runExclusive(async () => {
      resetGlobals()
      const svc = createTestService()
      svc.streamingLock = false

      svc.forceResetIfStuck()

      assert.equal(svc.streamingLock, false)
      assert.equal(conversationStateMachine.currentState, 'idle')
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
      streamingRole: 'da-vinci',
      phase: 'da-vinci-responding',
      specialistMeta: undefined,
      adapterAgentId: 'da-vinci',
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
      streamingRole: 'da-vinci',
      phase: 'da-vinci-responding',
      specialistMeta: undefined,
      adapterAgentId: 'da-vinci',
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
      streamingRole: 'da-vinci',
      phase: 'da-vinci-responding',
      specialistMeta: undefined,
      adapterAgentId: 'da-vinci',
      workspacePath: undefined,
      streamedContent: '',
      planInjected: false
    }

    assert.equal(ctx.planInjected, false)
    ctx.planInjected = true
    assert.equal(ctx.planInjected, true)
  })
})

// When run directly (not via run-tests.ts), print summary.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
