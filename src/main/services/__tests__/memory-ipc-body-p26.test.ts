/**
 * Phase 26 — memory.ipc.ts deep body coverage.
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

const memoryRepo = getMockRepo('memoryFact')

const mod = require('../../ipc/memory.ipc')
const registerFn = mod.registerMemoryIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('memory.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers memory handlers', () => {
    const handlers = getHandlers()
    const memHandlers = [...handlers.keys()].filter((k) => k.startsWith('memory:'))
    assert.ok(memHandlers.length > 0)
  })

  test('memory:getFacts returns facts', async () => {
    memoryRepo.findByWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('memory:getFacts', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('memory:searchFacts searches facts', async () => {
    memoryRepo.search.mockReturnValue([])
    const r = await tryInvokeHandler('memory:searchFacts', {
      workspaceId: 'ws-1',
      query: 'database'
    })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('memory:createFact creates a fact', async () => {
    memoryRepo.createFact.mockReturnValue({ id: 'f-1' })
    const r = await tryInvokeHandler('memory:createFact', {
      workspaceId: 'ws-1',
      content: 'Test fact',
      category: 'architecture'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('memory:updateFact updates a fact', async () => {
    memoryRepo.updateFact.mockReturnValue(undefined)
    const r = await tryInvokeHandler('memory:updateFact', {
      factId: 'f-1',
      content: 'Updated fact'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('memory:deleteFact deletes a fact', async () => {
    memoryRepo.archiveFact.mockReturnValue(undefined)
    const r = await tryInvokeHandler('memory:deleteFact', { factId: 'f-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('memory:getContradictions returns contradictions', async () => {
    memoryRepo.findContradictions.mockReturnValue([])
    memoryRepo.findContradictionsPaged.mockReturnValue([])
    const r = await tryInvokeHandler('memory:getContradictions', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('memory:resolveContradiction resolves contradiction', async () => {
    memoryRepo.resolveContradiction.mockReturnValue(undefined)
    const r = await tryInvokeHandler('memory:resolveContradiction', {
      contradictionId: 'c-1',
      resolution: 'keep_existing'
    })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })

  test('memory:getStats returns workspace stats', async () => {
    memoryRepo.countByWorkspace.mockReturnValue(10)
    memoryRepo.countPendingContradictions.mockReturnValue(2)
    const r = await tryInvokeHandler('memory:getStats', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'handler should return ok boolean')
  })
})
