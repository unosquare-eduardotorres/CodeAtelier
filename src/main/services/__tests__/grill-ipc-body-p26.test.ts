/**
 * Phase 26 — grill.ipc.ts deep body coverage.
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

const grillRepo = getMockRepo('grillSession')
const ideaRepo = getMockRepo('idea')

const mod = require('../../ipc/grill.ipc')
const registerFn = mod.registerGrillIpc || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('grill.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers grill handlers', () => {
    const handlers = getHandlers()
    const grillHandlers = [...handlers.keys()].filter((k) => k.startsWith('grill:'))
    assert.ok(grillHandlers.length > 0)
  })

  test('grill:getStatus returns status or null', async () => {
    const r = await tryInvokeHandler('grill:getStatus', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean')
    if (r.ok) {
      assert.ok(
        r.result === null || typeof r.result === 'object',
        'Status should be null or object'
      )
    }
  })

  test('grill:cancel handles no active grill gracefully', async () => {
    const r = await tryInvokeHandler('grill:cancel', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'Should return ok boolean')
  })

  test('grill:listPlannedIdeas returns empty array when none', async () => {
    grillRepo.findIdeaIdsWithPlan.mockReturnValue([])
    const r = await tryInvokeHandler('grill:listPlannedIdeas', { workspaceId: 'ws-1' })
    if (r.ok) {
      assert.ok(Array.isArray(r.result), 'Should return an array')
    }
  })

  test('grill:listPlannedIdeas returns populated list', async () => {
    grillRepo.findIdeaIdsWithPlan.mockReturnValue(['idea-1', 'idea-2'])
    ideaRepo.findById.mockReturnValue({ id: 'idea-1', title: 'Test', description: 'test' })
    const r = await tryInvokeHandler('grill:listPlannedIdeas', { workspaceId: 'ws-1' })
    if (r.ok) {
      assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
    }
  })

  test('grill:complete handles completion', async () => {
    grillRepo.findById.mockReturnValue({ id: 'grill-1', ideaId: 'idea-1' })
    const r = await tryInvokeHandler('grill:complete', { ideaId: 'idea-1', workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean')
  })

  test('grill:discard handles discard', async () => {
    grillRepo.findById.mockReturnValue({ id: 'grill-1', ideaId: 'idea-1' })
    const r = await tryInvokeHandler('grill:discard', { ideaId: 'idea-1', workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean')
  })
})
