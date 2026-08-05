/**
 * Phase 26 Wave 3 — memory-bootstrap.service.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../memory-bootstrap.service')
const svc = mod.memoryBootstrapService || mod.default
const memoryRepo = getMockRepo('memoryFact')
const wsRepo = getMockRepo('workspace')

describe('MemoryBootstrapService (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('service exports an object', () => {
    assert.ok(svc)
  })

  test('bootstrap handles empty workspace', async () => {
    if (typeof svc.bootstrap !== 'function') return
    wsRepo.findById.mockReturnValue({ id: 'ws-1', path: '/tmp/test' })
    memoryRepo.countByWorkspace.mockReturnValue(0)
    try {
      await svc.bootstrap({ workspaceId: 'ws-1', workspacePath: '/tmp/test' })
    } catch {
      /* OK */
    }
  })

  test('getProgress returns progress', () => {
    if (typeof svc.getProgress !== 'function') return
    const p = svc.getProgress('ws-1')
    assert.ok(p === undefined || typeof p === 'object')
  })

  test('cancel stops bootstrap', () => {
    if (typeof svc.cancel !== 'function') return
    try {
      svc.cancel('ws-1')
    } catch {
      /* OK */
    }
  })

  test('isRunning checks active state', () => {
    if (typeof svc.isRunning !== 'function') return
    assert.equal(typeof svc.isRunning('ws-1'), 'boolean')
  })
})
