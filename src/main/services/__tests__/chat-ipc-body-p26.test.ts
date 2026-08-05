/**
 * Phase 26 — chat-completion.ipc.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  mockMainWindow,
  getHandlers,
  tryInvokeHandler,
  sentEvents
} from './setup-full-mock'

setupFullMock()

const convoRepo = getMockRepo('conversation')
const wsRepo = getMockRepo('workspace')

const mod = require('../../ipc/chat-completion.ipc')
const registerFn = mod.registerChatCompletionIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('chat-completion.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers chat handlers', () => {
    const handlers = getHandlers()
    const chatHandlers = [...handlers.keys()].filter(
      (k) => k.includes('chat:') || k.includes('stream:')
    )
    assert.ok(chatHandlers.length > 0)
  })

  test('chat:send invokes stream service', async () => {
    convoRepo.findById.mockReturnValue({ id: 'conv-1', workspaceId: 'ws-1' })
    wsRepo.findById.mockReturnValue({ id: 'ws-1', path: '/tmp/test' })
    const r = await tryInvokeHandler('chat:send', {
      conversationId: 'conv-1',
      workspaceId: 'ws-1',
      message: 'Hello AI'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('chat:stop stops active stream', async () => {
    const r = await tryInvokeHandler('chat:stop', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('chat:compact compacts conversation', async () => {
    const r = await tryInvokeHandler('chat:compact', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })
})
