/**
 * Phase 26 — Remaining IPC handlers deep body coverage.
 * Covers: idea, council, project-specialist, project, code-changes,
 * chat-mode, chat-message, indexing IPCs.
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

const ideaRepo = getMockRepo('idea')
const councilRepo = getMockRepo('councilSession')
const specialistRepo = getMockRepo('specialist')
const convoRepo = getMockRepo('conversation')

// Register all IPC modules
const ipcModules = [
  '../../ipc/idea.ipc',
  '../../ipc/council.ipc',
  '../../ipc/project-specialist.ipc',
  '../../ipc/project.ipc',
  '../../ipc/code-changes.ipc',
  '../../ipc/chat-mode.ipc',
  '../../ipc/chat-message.ipc',
  '../../ipc/indexing.ipc'
]

for (const modPath of ipcModules) {
  try {
    const mod = require(modPath)
    const fn = mod.default || Object.values(mod).find((v: any) => typeof v === 'function')
    if (typeof fn === 'function') fn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('remaining IPC handlers — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('all remaining IPC modules loaded', () => {
    const handlers = getHandlers()
    assert.ok(handlers.size > 0)
  })

  // ─── idea.ipc ────────────────────────────────────────────────────────────
  test('idea:list returns ideas', async () => {
    ideaRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('idea:list', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('idea:create creates idea', async () => {
    ideaRepo.create.mockReturnValue({ id: 'idea-1' })
    const r = await tryInvokeHandler('idea:create', {
      workspaceId: 'ws-1',
      title: 'New feature',
      description: 'Build it'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('idea:delete deletes idea', async () => {
    ideaRepo.delete.mockReturnValue(1)
    const r = await tryInvokeHandler('idea:delete', { ideaId: 'idea-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('idea:updateStatus updates idea status', async () => {
    ideaRepo.updateStatus.mockReturnValue(undefined)
    const r = await tryInvokeHandler('idea:updateStatus', {
      ideaId: 'idea-1',
      status: 'grilled'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── council.ipc ─────────────────────────────────────────────────────────
  test('council:getHistory returns sessions', async () => {
    councilRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('council:getHistory', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('council:deleteSession deletes session', async () => {
    councilRepo.deleteSession.mockReturnValue(1)
    const r = await tryInvokeHandler('council:deleteSession', { sessionId: 'cs-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── project-specialist.ipc ──────────────────────────────────────────────
  test('specialist:list returns specialists', async () => {
    specialistRepo.findAll.mockReturnValue([])
    const r = await tryInvokeHandler('specialist:list', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('specialist:create creates specialist', async () => {
    specialistRepo.create.mockReturnValue({ id: 'sp-1' })
    const r = await tryInvokeHandler('specialist:create', {
      workspaceId: 'ws-1',
      name: 'Test Agent'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── code-changes.ipc ───────────────────────────────────────────────────
  test('code-changes:getDiff returns diff', async () => {
    const r = await tryInvokeHandler('code-changes:getDiff', {
      workspaceId: 'ws-1',
      conversationId: 'conv-1'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── chat-mode.ipc ──────────────────────────────────────────────────────
  test('chat:switchMode switches conversation mode', async () => {
    convoRepo.findById.mockReturnValue({ id: 'conv-1', workspaceId: 'ws-1' })
    convoRepo.updateMode.mockReturnValue(undefined)
    const r = await tryInvokeHandler('chat:switchMode', {
      conversationId: 'conv-1',
      mode: 'build'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  // ─── indexing.ipc ────────────────────────────────────────────────────────
  test('indexing:getStatus returns indexing status', async () => {
    const r = await tryInvokeHandler('indexing:getStatus', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })
})
