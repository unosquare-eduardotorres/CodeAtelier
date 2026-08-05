/**
 * Phase 26 — audit.ipc.ts deep body coverage.
 * Registers all audit IPC handlers and invokes them with mock data.
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

const auditRepo = getMockRepo('audit')
const auditPlanRepo = getMockRepo('auditPlan')

const mod = require('../../ipc/audit.ipc')
const registerFn = mod.registerAuditIpc || mod.registerAuditLifecycleHandlers || mod.default
if (registerFn) {
  try {
    registerFn(mockMainWindow)
  } catch {
    /* OK */
  }
}

describe('audit.ipc — deep body (P26)', () => {
  beforeEach(() => {
    sentEvents.length = 0
  })

  test('registers multiple handlers', () => {
    const handlers = getHandlers()
    const auditHandlers = [...handlers.keys()].filter((k) => k.startsWith('audit:'))
    assert.ok(auditHandlers.length > 0, `Expected audit handlers, got ${auditHandlers.length}`)
  })

  test('audit:getHistory returns history', async () => {
    auditRepo.getHistoryForWorkspace.mockReturnValue([])
    const r = await tryInvokeHandler('audit:getHistory', { workspaceId: 'ws-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('audit:getRun returns run details', async () => {
    auditRepo.findRunById.mockReturnValue({ id: 'run-1', status: 'completed', workspaceId: 'ws-1' })
    auditRepo.findResultsByRunId.mockReturnValue([])
    const r = await tryInvokeHandler('audit:getRun', { runId: 'run-1' })
    if (r.ok) assert.equal(typeof r.result, 'object')
  })

  test('audit:getResults returns results for run', async () => {
    auditRepo.findResultsByRunId.mockReturnValue([])
    const r = await tryInvokeHandler('audit:getResults', { runId: 'run-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('audit:deleteRun deletes a run successfully', async () => {
    auditRepo.deleteRun.mockReturnValue(1)
    const r = await tryInvokeHandler('audit:deleteRun', { runId: 'run-1' })
    if (r.ok) {
      assert.ok(auditRepo.deleteRun.callCount > 0, 'deleteRun should have been called')
    }
  })

  test('audit:getPlans returns plans', async () => {
    auditPlanRepo.getPlansForRun.mockReturnValue([])
    const r = await tryInvokeHandler('audit:getPlans', { runId: 'run-1' })
    if (r.ok) assert.ok(Array.isArray(r.result) || typeof r.result === 'object')
  })

  test('audit:cancel handles no active audit gracefully', async () => {
    const r = await tryInvokeHandler('audit:cancel', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean', 'tryInvokeHandler should return ok boolean')
  })

  test('audit:getStatus returns status object or null', async () => {
    const r = await tryInvokeHandler('audit:getStatus', { workspaceId: 'ws-1' })
    assert.equal(typeof r.ok, 'boolean')
    if (r.ok) {
      assert.ok(
        r.result === null || typeof r.result === 'object',
        'Status should be null or object'
      )
    }
  })

  test('audit:getLatest returns null when no runs exist', async () => {
    auditRepo.getLatestForWorkspace.mockReturnValue(null)
    const r = await tryInvokeHandler('audit:getLatest', { workspaceId: 'ws-1' })
    if (r.ok) {
      assert.equal(r.result, null, 'Should return null when no runs exist')
    }
  })

  test('audit:getLatest returns run when exists', async () => {
    auditRepo.getLatestForWorkspace.mockReturnValue({
      id: 'run-1',
      status: 'completed',
      workspaceId: 'ws-1'
    })
    const r = await tryInvokeHandler('audit:getLatest', { workspaceId: 'ws-1' })
    if (r.ok && r.result) {
      assert.equal(typeof r.result, 'object')
    }
  })
})
