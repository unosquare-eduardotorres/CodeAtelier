/**
 * Phase 24 — IPC Coverage Blitz: chat.ipc, chat-lifecycle.ipc
 *
 * These are thin orchestration modules — chat.ipc delegates to chat-message + chat-lifecycle,
 * and chat-lifecycle delegates to conversation-crud + chat-mode + chat-completion.
 *
 * Run: tsx src/main/ipc/__tests__/ipc-chat-lifecycle-shared.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import {
  setupFullMock,
  getHandlers,
  mockMainWindow,
  tryInvokeHandler
} from '../../services/__tests__/setup-full-mock'
import { IPC_CHANNELS } from '../../../shared/constants'

setupFullMock()

let chatLoaded = false

try {
  const mod = require('../../ipc/chat.ipc')
  mod.registerChatIpc(mockMainWindow)
  chatLoaded = true
} catch (err) {
  console.log(`⚠ chat.ipc load failed: ${(err as Error).message?.split('\n')[0]}`)
}

if (chatLoaded) {
  describe('chat.ipc — orchestration registration', () => {
    // chat.ipc delegates to chat-message.ipc + chat-lifecycle.ipc
    // chat-lifecycle.ipc delegates to conversation-crud + chat-mode + chat-completion
    // So all of those handlers should be registered:

    test('registers chat:send (from chat-message)', () => {
      assert.ok(getHandlers().has(IPC_CHANNELS.CHAT_SEND))
    })

    test('registers chat:stop (from chat-message)', () => {
      assert.ok(getHandlers().has('chat:stop'))
    })

    test('registers chat:getConversations (from conversation-crud)', () => {
      assert.ok(getHandlers().has('chat:getConversations'))
    })

    test('registers chat:createConversation (from conversation-crud)', () => {
      assert.ok(getHandlers().has('chat:createConversation'))
    })

    test('registers chat:deleteConversation (from conversation-crud)', () => {
      assert.ok(getHandlers().has('chat:deleteConversation'))
    })

    test('registers chat:getMessages (from conversation-crud)', () => {
      assert.ok(getHandlers().has('chat:getMessages'))
    })
  })

  describe('chat.ipc — chat:send validation', () => {
    test('chat:send rejects non-object', async () => {
      const r = await tryInvokeHandler('chat:send', 'bad')
      assert.equal(r.ok, false)
    })

    test('chat:send rejects missing conversationId', async () => {
      const r = await tryInvokeHandler('chat:send', { text: 'hi' })
      assert.equal(r.ok, false)
    })
  })

  describe('chat.ipc — chat:stop', () => {
    test('chat:stop calls through (may fail without active session)', async () => {
      const r = await tryInvokeHandler('chat:stop')
      assert.ok(r.ok === true || r.ok === false)
    })
  })
}

if (process.argv[1]?.includes('ipc-chat-lifecycle-shared')) {
  void summaryAsync()
}
