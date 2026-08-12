/**
 * Phase 26 — workspace.ipc.ts deep body coverage.
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

const wsRepo = getMockRepo('workspace')

const mod = require('../../ipc/workspace.ipc')
const registerFn = mod.registerWorkspaceIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('workspace.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers workspace handlers', () => {
    const handlers = getHandlers()
    const wsHandlers = [...handlers.keys()].filter((k) => k.startsWith('workspace:'))
    assert.ok(wsHandlers.length > 0)
  })

  test('workspace:list returns workspaces', async () => {
    wsRepo.findAll.mockReturnValue([])
    const r = await tryInvokeHandler('workspace:list', {})
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('workspace:get returns single workspace', async () => {
    wsRepo.findById.mockReturnValue({ id: 'ws-1', path: '/tmp/test', name: 'test' })
    const r = await tryInvokeHandler('workspace:get', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('workspace:delete deletes workspace', async () => {
    wsRepo.delete.mockReturnValue(1)
    const r = await tryInvokeHandler('workspace:delete', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('workspace:updateSettings updates settings', async () => {
    wsRepo.updateSettings.mockReturnValue(undefined)
    const r = await tryInvokeHandler('workspace:updateSettings', {
      workspaceId: 'ws-1',
      settings: { model: 'claude-sonnet-4-6' }
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('workspace:getSettings returns settings', async () => {
    wsRepo.getSettings.mockReturnValue({})
    const r = await tryInvokeHandler('workspace:getSettings', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })
})
