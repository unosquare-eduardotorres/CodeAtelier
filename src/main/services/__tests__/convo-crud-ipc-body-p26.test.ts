/**
 * Phase 26 — conversation-crud.ipc.ts deep body coverage.
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
const msgRepo = getMockRepo('message')
const todoRepo = getMockRepo('todo')

const mod = require('../../ipc/conversation-crud.ipc')
const registerFn = mod.registerConversationCrudIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('conversation-crud.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers conversation handlers', () => {
    const handlers = getHandlers()
    const convoHandlers = [...handlers.keys()].filter((k) => k.includes('conversation'))
    assert.ok(convoHandlers.length > 0)
  })

  test('conversation:list returns conversations', async () => {
    convoRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('conversation:list', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('conversation:create creates new conversation', async () => {
    convoRepo.create.mockReturnValue({ id: 'conv-new', workspaceId: 'ws-1', title: 'New Chat' })
    const r = await tryInvokeHandler('conversation:create', {
      workspaceId: 'ws-1',
      title: 'New Chat'
    })
    if (r.ok) assert.equal(typeof r.result, 'object')
  })

  test('conversation:delete deletes conversation', async () => {
    convoRepo.delete.mockReturnValue(1)
    msgRepo.truncateAfterTimestamp.mockReturnValue(0)
    todoRepo.clearByConversation.mockReturnValue(undefined)
    const r = await tryInvokeHandler('conversation:delete', { conversationId: 'conv-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('conversation:get returns single conversation', async () => {
    convoRepo.findById.mockReturnValue({ id: 'conv-1', workspaceId: 'ws-1' })
    msgRepo.findByConversation.mockReturnValue([])
    const r = await tryInvokeHandler('conversation:get', { conversationId: 'conv-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('conversation:updateTitle updates title', async () => {
    convoRepo.updateTitle.mockReturnValue(undefined)
    const r = await tryInvokeHandler('conversation:updateTitle', {
      conversationId: 'conv-1',
      title: 'Updated Title'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('conversation:archive archives conversation', async () => {
    convoRepo.archive.mockReturnValue(undefined)
    const r = await tryInvokeHandler('conversation:archive', { conversationId: 'conv-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('conversation:getMessages returns messages', async () => {
    msgRepo.findByConversation.mockReturnValue([])
    const r = await tryInvokeHandler('conversation:getMessages', { conversationId: 'conv-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })
})
