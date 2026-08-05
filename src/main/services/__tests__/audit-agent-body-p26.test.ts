/**
 * Phase 26 Wave 3 — audit-agent.service.ts deep body coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. AuditAgentService has no `getStatus` method (the
 * old test silently no-op'd on that guess) — the real read is
 * `isRunningForWorkspace(workspaceId)`. Running the full multi-round audit
 * pipeline needs a deep LLM-session mock that's out of scope here; instead
 * these tests exercise the real, deterministic guard/event logic every
 * runAudit() call passes through, reading/writing the service's own
 * `workspaceStates` map via bracket notation (TypeScript `private` is
 * compile-time only).
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../audit-agent.service')
const { auditAgentService: svc } = mod

describe('AuditAgentService (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
    svc['workspaceStates'].clear()
  })

  test('service exports an object with the audit API', () => {
    assert.ok(svc)
    assert.equal(typeof svc.runAudit, 'function')
    assert.equal(typeof svc.cancel, 'function')
  })

  test('isRunningForWorkspace is false for a workspace with no audit state', () => {
    assert.equal(svc.isRunningForWorkspace('ws-unseen'), false)
    assert.equal(svc.isRunning, false)
  })

  test('isRunningForWorkspace reflects an in-progress state and is scoped per workspace', () => {
    svc['workspaceStates'].set('ws-active', { running: true, abortController: null, session: null })
    assert.equal(svc.isRunningForWorkspace('ws-active'), true)
    assert.equal(svc.isRunning, true)
    assert.equal(svc.isRunningForWorkspace('ws-other'), false)
  })

  test('cancel is a safe no-op for a workspace with no active audit', () => {
    svc.cancel('ws-idle')
  })

  test('cancel aborts the running audit for the given workspace', () => {
    const abortController = new AbortController()
    svc['workspaceStates'].set('ws-cancel', { running: true, abortController, session: null })

    svc.cancel('ws-cancel')

    assert.equal(abortController.signal.aborted, true)
  })

  test('runAudit ignores a second concurrent call for the same workspace and fires no progress event', async () => {
    svc['workspaceStates'].set('ws-busy', { running: true, abortController: null, session: null })
    let progressFired = false
    const onProgress = (): void => {
      progressFired = true
    }
    svc.on('progress', onProgress)

    try {
      await svc.runAudit({
        workspaceId: 'ws-busy',
        workspacePath: '/tmp/audit-test',
        mode: 'quick',
        selectedTracks: ['security'],
        auditRunId: 'run-busy'
      })
      assert.equal(progressFired, false)
      // The guard returns before touching state — still marked running from setup.
      assert.equal(svc.isRunningForWorkspace('ws-busy'), true)
    } finally {
      svc.off('progress', onProgress)
    }
  })

  test('runAudit with no selected tracks completes immediately with a null overall score', async () => {
    let completePayload: { overallScore: number | null } | undefined
    const onComplete = (payload: { overallScore: number | null }): void => {
      completePayload = payload
    }
    svc.on('complete', onComplete)

    try {
      await svc.runAudit({
        workspaceId: 'ws-empty-tracks',
        workspacePath: '/tmp/audit-test',
        mode: 'quick',
        selectedTracks: [],
        auditRunId: 'run-empty'
      })

      assert.ok(completePayload)
      // No tracks ran to completion, so calculateOverallScore has nothing to average.
      assert.equal(completePayload!.overallScore, null)
      assert.equal(svc.isRunningForWorkspace('ws-empty-tracks'), false)
    } finally {
      svc.off('complete', onComplete)
    }
  })
})
