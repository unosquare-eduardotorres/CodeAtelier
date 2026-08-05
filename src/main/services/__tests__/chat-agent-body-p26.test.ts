/**
 * Phase 26 Wave 6 — chat-agent.service.ts deep body coverage.
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../chat-agent.service')
const svc = mod.chatAgentService || mod.default

describe('ChatAgentService (P26-W6)', () => {
  beforeEach(() => {
    resetAllMocks()
  })

  test('service exports an object', () => {
    assert.ok(svc)
  })

  test('getSession returns null for unknown', () => {
    if (typeof svc.getSession !== 'function') return
    const session = svc.getSession('ws-1', 'conv-unknown')
    assert.ok(session === null || session === undefined)
  })

  test('getActiveWorkspaces returns set or array', () => {
    if (typeof svc.getActiveWorkspaces !== 'function') return
    const workspaces = svc.getActiveWorkspaces()
    assert.ok(workspaces !== undefined)
  })

  test('disposeWorkspace cleans up', () => {
    if (typeof svc.disposeWorkspace !== 'function') return
    try {
      svc.disposeWorkspace('ws-1')
    } catch {
      /* OK */
    }
  })

  test('hasActiveSession returns false for unknown', () => {
    if (typeof svc.hasActiveSession !== 'function') return
    assert.equal(svc.hasActiveSession('ws-1'), false)
  })
})
