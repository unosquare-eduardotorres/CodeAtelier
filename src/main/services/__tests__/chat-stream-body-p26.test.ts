/**
 * Phase 26 — chat-stream.service.ts deep body coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. The previous version also guessed at APIs that
 * don't exist — the constructor takes (mainWindow, callbacks) not just
 * (mainWindow); resolveStreamingConversationId/resolveStreamIdentity take
 * NO arguments; stop()/stopSingleConversation() take a single
 * conversationId, not (workspaceId, conversationId); registerEventForwarders
 * and buildStreamListeners have real signatures very different from the
 * guessed ones. All exercised against their real signatures below.
 *
 * Full stream() orchestration needs a deep chatAgentService/executor mock
 * that's out of scope here (see plan slice P9) — these tests cover the
 * lifecycle/lock/formatting methods this file actually owns, each verified
 * against real return values, real repo-spy calls, or real IPC sends
 * (via a per-test local window mock so assertions never race a sibling
 * test's shared spy — see the note in memory-extract-body-p26.test.ts about
 * this harness's eager sibling-beforeEach scheduling).
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, createSpy, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../chat-stream.service')
const { ChatStreamService, initChatStream } = mod
const { flushTextBatcher } = require('../../ipc/chunk-router')

const wsRepo = getMockRepo('workspace')

let convCounter = 0
/** Unique conversation id per test — avoids collisions in the shared lifecycle registry. */
function nextConvId(): string {
  convCounter += 1
  return `p26-conv-${convCounter}`
}

/** A window mock with its own local send spy — never shared across tests. */
function fakeWindow(destroyed = false): { isDestroyed: () => boolean; webContents: { send: any } } {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: createSpy() }
  }
}

function fakeCallbacks(): { onStopPipeline: any } {
  return { onStopPipeline: createSpy(async () => {}) }
}

describe('ChatStreamService — deep body (P26)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  // ─── Singleton / init ────────────────────────────────────────────────────
  test('ChatStreamService is exported as a class; initChatStream builds the singleton', () => {
    assert.equal(typeof ChatStreamService, 'function')
    const instance = initChatStream(fakeWindow(), fakeCallbacks())
    assert.ok(instance instanceof ChatStreamService)
  })

  // ─── Constructor ─────────────────────────────────────────────────────────
  test('constructor wires the streaming API onto a fresh instance', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    assert.equal(typeof svc.stream, 'function')
    assert.equal(typeof svc.stop, 'function')
    assert.equal(typeof svc.compact, 'function')
    svc.dispose()
  })

  // ─── safeWindowSend ──────────────────────────────────────────────────────
  test('safeWindowSend forwards to webContents.send on a live window', () => {
    const window = fakeWindow(false)
    const svc = new ChatStreamService(window, fakeCallbacks())

    svc['safeWindowSend']('test-channel', { data: 'value' })

    assert.equal(window.webContents.send.callCount, 1)
    assert.deepEqual(window.webContents.send.lastCall, ['test-channel', { data: 'value' }])
    svc.dispose()
  })

  test('safeWindowSend is a no-op guard on a destroyed window', () => {
    const window = fakeWindow(true)
    const svc = new ChatStreamService(window, fakeCallbacks())

    svc['safeWindowSend']('test-channel', { data: 'value' })

    assert.equal(window.webContents.send.callCount, 0)
    svc.dispose()
  })

  // ─── resolveWorkspaceName ────────────────────────────────────────────────
  test('resolveWorkspaceName returns the workspace name when found, else a truncated id fallback', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())

    wsRepo.findById.mockReturnValue({ id: 'ws-1', name: 'TestProject', path: '/tmp/test' })
    assert.equal(svc['resolveWorkspaceName']('ws-1'), 'TestProject')

    wsRepo.findById.mockReturnValue(undefined)
    assert.equal(svc['resolveWorkspaceName']('ws-abcdefghij'), 'ws-abcde')
    svc.dispose()
  })

  // ─── resolveStreamIdentity ───────────────────────────────────────────────
  test('resolveStreamIdentity returns the unified specialist role and phase', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const identity = svc['resolveStreamIdentity']()

    // Code Atelier has exactly one role adapter — every stream identity resolves to 'specialist'.
    assert.equal(identity.streamingRole, 'specialist')
    assert.equal(identity.phase, 'specialist-executing')
    assert.equal(typeof identity.adapterAgentId, 'string')
    svc.dispose()
  })

  // ─── acquireStreamLock ───────────────────────────────────────────────────
  test('acquireStreamLock returns a live lock with a signal and a done promise, then releases cleanly', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const conversationId = nextConvId()

    const lock = svc['acquireStreamLock'](conversationId)
    try {
      assert.equal(typeof lock.requestId, 'string')
      assert.equal(lock.signal.aborted, false)
      assert.equal(typeof lock.done.then, 'function')
      assert.equal(lock.lifecycle.isActive, true)
    } finally {
      lock.lifecycle.abort('test-cleanup')
      svc.dispose()
    }
  })

  test('acquireStreamLock rejects a second concurrent lock for the same conversation', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const conversationId = nextConvId()

    const lock = svc['acquireStreamLock'](conversationId)
    try {
      assert.throws(
        () => svc['acquireStreamLock'](conversationId),
        /already streaming|already being processed/
      )
    } finally {
      lock.lifecycle.abort('test-cleanup')
      svc.dispose()
    }
  })

  // ─── stop / stopSingleConversation ────────────────────────────────────────
  test('stop() with no active stream still invokes the onStopPipeline callback and resolves', async () => {
    const callbacks = fakeCallbacks()
    const svc = new ChatStreamService(fakeWindow(), callbacks)

    await svc.stop(nextConvId())

    assert.equal(callbacks.onStopPipeline.callCount, 1)
    svc.dispose()
  })

  // ─── compact ─────────────────────────────────────────────────────────────
  test('compact() rejects when there is no active session to compact', async () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    await assert.rejects(svc.compact(nextConvId()), /Agent not running/)
    svc.dispose()
  })

  // ─── forceResetIfStuck / clearConversationMemoryState / dispose ──────────
  test('dispose() marks the instance disposed and is safe to call from a fresh instance', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    assert.equal(svc['isDisposed'], false)

    svc.forceResetIfStuck('ws-stuck')
    svc.clearConversationMemoryState(nextConvId())
    svc.dispose()

    assert.equal(svc['isDisposed'], true)
  })

  // ─── processAttachments ──────────────────────────────────────────────────
  test('processAttachments returns empty text and no images for an empty attachment list', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const result = svc['processAttachments']([])
    assert.deepEqual(result, { textContent: '', images: [] })
    svc.dispose()
  })

  test('processAttachments records a read failure inline instead of throwing', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const result = svc['processAttachments'](['/definitely/does/not/exist.txt'])
    assert.equal(result.images.length, 0)
    assert.match(result.textContent, /Failed to read/)
    svc.dispose()
  })

  // ─── prepareUserMessage ──────────────────────────────────────────────────
  test('prepareUserMessage returns the raw text with no image attachments when none are given', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const msg = svc['prepareUserMessage']('Hello AI')
    assert.deepEqual(msg, { fullContent: 'Hello AI', imageAttachments: [] })
    svc.dispose()
  })

  // ─── registerEventForwarders ─────────────────────────────────────────────
  test('registerEventForwarders (no args) registers additional persistent listener cleanups', () => {
    const svc = new ChatStreamService(fakeWindow(), fakeCallbacks())
    const before = svc['eventCleanups'].length

    svc['registerEventForwarders']()

    assert.ok(svc['eventCleanups'].length > before)
    svc.dispose()
  })

  // ─── buildStreamListeners + onChunk ───────────────────────────────────────
  test('buildStreamListeners returns the 4 stream callbacks, and onChunk forwards a chunk to the window', () => {
    const window = fakeWindow(false)
    const svc = new ChatStreamService(window, fakeCallbacks())
    const conversationId = nextConvId()
    const lock = svc['acquireStreamLock'](conversationId)

    try {
      const identity = svc['resolveStreamIdentity']()
      const ctx = {
        conversationId,
        requestId: lock.requestId,
        streamingRole: identity.streamingRole,
        phase: identity.phase,
        specialistMeta: identity.specialistMeta,
        adapterAgentId: identity.adapterAgentId,
        workspacePath: undefined,
        startSha: undefined,
        streamedContent: '',
        planInjected: false
      }

      const listeners = svc['buildStreamListeners'](ctx, lock.lifecycle, lock.resolveDone, lock.rejectDone)
      assert.equal(typeof listeners.onChunk, 'function')
      assert.equal(typeof listeners.onComplete, 'function')
      assert.equal(typeof listeners.onIntent, 'function')
      assert.equal(typeof listeners.onPlanEvent, 'function')

      listeners.onChunk({ type: 'text', content: 'hi there' } as any)
      flushTextBatcher(conversationId)

      assert.equal(window.webContents.send.callCount, 1)
      const [channel, payload] = window.webContents.send.lastCall
      assert.equal(channel, 'chat:messageChunk')
      assert.equal(payload.conversationId, conversationId)
      assert.equal(payload.chunk, 'hi there')
    } finally {
      lock.lifecycle.abort('test-cleanup')
      svc.dispose()
    }
  })
})
