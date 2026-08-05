/**
 * Phase 26 Wave 3 — mpa-orchestration.service.ts deep body coverage.
 *
 * R003: rewritten to assert real behaviour instead of bare catch{} swallows
 * and typeof-guard skips. The full phase loop (plan → gate → execute →
 * verify) needs a deep AgentSessionService mock that's out of scope here —
 * instead these tests exercise the real, deterministic guard/state logic
 * that every orchestrate()/resumeRun() call passes through, using the
 * service's own pipeline/startLocks state (read via bracket notation, since
 * TypeScript `private` is compile-time only and the harness runs on
 * transpiled JS).
 */
import assert from 'node:assert/strict'
import { describe, test, beforeEach } from './test-harness'
import { setupFullMock, getMockRepo, createSpy, resetAllMocks } from './setup-full-mock'
setupFullMock()

const mod = require('../mpa-orchestration.service')
const { mpaOrchestrationService: svc } = mod
const mpaRunRepo = getMockRepo('mpaRun')

describe('MpaOrchestrationService (P26-W3)', () => {
  beforeEach(() => {
    resetAllMocks()
    svc['pipelines'].clear()
    svc['startLocks'].clear()
  })

  test('service exports an object with the orchestration API', () => {
    assert.ok(svc)
    assert.equal(typeof svc.orchestrate, 'function')
    assert.equal(typeof svc.resumeRun, 'function')
  })

  // ─── getStatus / isRunningForWorkspace ───────────────────────────────────
  test('getStatus reports not-running for a workspace with no pipeline', () => {
    assert.deepEqual(svc.getStatus('ws-unknown'), { running: false, runId: null })
    assert.equal(svc.isRunningForWorkspace('ws-unknown'), false)
  })

  test('getStatus reflects an active pipeline for its workspace only', () => {
    svc['pipelines'].set('ws-active', {
      running: true,
      abortController: null,
      currentPhaseSession: null,
      pendingGateResolve: null,
      currentRunId: 'run-active'
    })

    assert.deepEqual(svc.getStatus('ws-active'), { running: true, runId: 'run-active' })
    assert.equal(svc.isRunningForWorkspace('ws-active'), true)
    // A different, untracked workspace is unaffected.
    assert.equal(svc.isRunningForWorkspace('ws-other'), false)
  })

  // ─── orchestrate — guard clauses (real, hermetic — no phase loop reached) ──
  test('orchestrate rejects when a start lock is already held for the workspace', async () => {
    svc['startLocks'].add('ws-locked')
    await assert.rejects(
      svc.orchestrate({ workspaceId: 'ws-locked', workspacePath: '/tmp/x', goal: 'g', title: 't', goalType: 'feature', phases: [] }),
      /MPA start lock held for workspace ws-locked/
    )
  })

  test('orchestrate rejects when the pipeline is already running for the workspace', async () => {
    svc['pipelines'].set('ws-running', {
      running: true,
      abortController: null,
      currentPhaseSession: null,
      pendingGateResolve: null,
      currentRunId: 'run-x'
    })

    await assert.rejects(
      svc.orchestrate({ workspaceId: 'ws-running', workspacePath: '/tmp/x', goal: 'g', title: 't', goalType: 'feature', phases: [] }),
      /MPA pipeline already running for workspace ws-running/
    )
  })

  // ─── cancel ───────────────────────────────────────────────────────────────
  test('cancel is a safe no-op for a workspace with no active pipeline', () => {
    // No pipeline registered for 'ws-idle' — must not throw and must not touch the repo.
    svc.cancel('ws-idle')
    assert.equal(mpaRunRepo.updateRun.callCount, 0)
  })

  test('cancel aborts the pipeline, updates the run to cancelled, and resolves the pending gate', () => {
    const abortController = new AbortController()
    const gateResolve = createSpy()
    svc['pipelines'].set('ws-cancel', {
      running: true,
      abortController,
      currentPhaseSession: null,
      pendingGateResolve: gateResolve,
      currentRunId: 'run-cancel'
    })
    mpaRunRepo.updateRun.mockReturnValue({ id: 'run-cancel', status: 'cancelled' })

    svc.cancel('ws-cancel')

    assert.equal(abortController.signal.aborted, true)
    assert.equal(mpaRunRepo.updateRun.lastCall[0], 'run-cancel')
    assert.equal(mpaRunRepo.updateRun.lastCall[1].status, 'cancelled')
    assert.equal(gateResolve.callCount, 1)
    assert.deepEqual(gateResolve.lastCall[0], { approved: false })
    // Gate resolver must be cleared so a second cancel() can't resolve it twice.
    assert.equal(svc['pipelines'].get('ws-cancel').pendingGateResolve, null)
  })

  // ─── respondToGate ────────────────────────────────────────────────────────
  test('respondToGate is a no-op when no pipeline tracks the given run', () => {
    // Must not throw even though no pipeline has this runId.
    svc.respondToGate('run-unknown', true)
  })

  test('respondToGate resolves the pending gate with the approval and feedback', () => {
    const gateResolve = createSpy()
    svc['pipelines'].set('ws-gate', {
      running: true,
      abortController: null,
      currentPhaseSession: null,
      pendingGateResolve: gateResolve,
      currentRunId: 'run-gate'
    })

    svc.respondToGate('run-gate', true, 'looks good')

    assert.equal(gateResolve.callCount, 1)
    assert.deepEqual(gateResolve.lastCall[0], { approved: true, feedback: 'looks good' })
    assert.equal(svc['pipelines'].get('ws-gate').pendingGateResolve, null)
  })

  // ─── resumeRun — guard clauses (real, hermetic — no phase loop reached) ───
  test('resumeRun rejects when the run does not exist', async () => {
    mpaRunRepo.findById.mockReturnValue(null)
    await assert.rejects(svc.resumeRun('run-missing'), /Run run-missing not found/)
  })

  test('resumeRun rejects a run that already completed', async () => {
    mpaRunRepo.findById.mockReturnValue({ id: 'run-done', status: 'completed', workspaceId: 'ws-1' })
    await assert.rejects(svc.resumeRun('run-done'), /Run already completed/)
  })

  test('resumeRun rejects a run that was cancelled', async () => {
    mpaRunRepo.findById.mockReturnValue({ id: 'run-c', status: 'cancelled', workspaceId: 'ws-1' })
    await assert.rejects(svc.resumeRun('run-c'), /Run was cancelled/)
  })

  test('resumeRun rejects when a start lock is already held for the run workspace', async () => {
    mpaRunRepo.findById.mockReturnValue({ id: 'run-locked', status: 'failed', workspaceId: 'ws-resume-locked' })
    svc['startLocks'].add('ws-resume-locked')

    await assert.rejects(svc.resumeRun('run-locked'), /MPA start lock held for workspace ws-resume-locked/)
  })
})
