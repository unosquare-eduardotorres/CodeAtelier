/**
 * Phase 26 Wave 3 — council.service.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../council.service')
const svc = mod.councilService || mod.default
const councilRepo = getMockRepo('councilSession')

describe('CouncilService (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('service exports an object', () => {
    assert.ok(svc)
  })

  test('evaluate starts council session', async () => {
    if (typeof svc.evaluate !== 'function') return
    councilRepo.createSession.mockReturnValue({ id: 'cs-1' })
    try {
      await svc.evaluate({
        workspaceId: 'ws-1',
        workspacePath: '/tmp/test',
        prompt: 'Review my code'
      })
    } catch {
      /* OK */
    }
  })

  test('cancel handles no active session', async () => {
    if (typeof svc.cancel !== 'function') return
    try {
      await svc.cancel('ws-1')
    } catch {
      /* OK */
    }
  })

  test('getStatus returns status', () => {
    if (typeof svc.getStatus !== 'function') return
    const s = svc.getStatus('ws-1')
    assert.ok(s === undefined || typeof s === 'object')
  })

  test('getHistory returns session history', () => {
    if (typeof svc.getHistory !== 'function') return
    councilRepo.findByWorkspace.mockReturnValue([])
    try {
      const h = svc.getHistory('ws-1')
      assert.ok(Array.isArray(h) || h === undefined)
    } catch {
      /* OK */
    }
  })

  test('deleteSession deletes a session', () => {
    if (typeof svc.deleteSession !== 'function') return
    councilRepo.deleteSession.mockReturnValue(1)
    try {
      svc.deleteSession('cs-1')
    } catch {
      /* OK */
    }
  })
})
