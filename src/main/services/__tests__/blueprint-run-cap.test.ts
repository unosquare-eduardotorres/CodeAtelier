/**
 * PARALLEL-RUNS — global concurrency cap + slot semantics.
 *
 * The cap: at most 3 blueprints hold run slots app-wide. A slot is held from
 * start until terminal status (complete/failed/cancelled); approval gates,
 * clarify gates, and remediation windows HOLD the slot. The 4th start is a
 * hard error naming the limit — no queue.
 *
 * These tests pin:
 *   - admitRun rejects at 3 held slots, admits at 2
 *   - awaiting-approval (gate-parked) machines hold a slot
 *   - failed/cancelled runs free their slot
 *   - admitRunUnlessHeld exempts a blueprint re-entering its own held slot
 *   - deleting a gate-parked blueprint frees its slot
 *   - the error message names the 3-run limit across two start paths
 *     (start-specify style fresh start + retry/resume re-entry)
 *   - two pipelines in ONE workspace both markPipelineRunning concurrently;
 *     aborting one leaves the other's AbortSignal live
 *
 * Pure in-memory: constructs BlueprintService directly (no DB rows needed —
 * workspaceId is passed to markPipelineRunning, machine keys are blueprintIds).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintService } from '../blueprint.service'

const MAX_CONCURRENT_BLUEPRINT_RUNS = 3

describe('BlueprintService — global run cap', () => {
  test('admitRun admits when no slots are held', async () => {
    const svc = new BlueprintService()
    const result = svc.admitRun()
    assert.deepEqual(result, { ok: true })
  })

  test('admitRun admits with 2 held slots', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-1', 'specify', 'ws-1')
    svc.markPipelineRunning('bp-2', 'specify', 'ws-1')
    const result = svc.admitRun()
    assert.deepEqual(result, { ok: true })
  })

  test('admitRun REJECTS the 4th start with 3 held slots — error names the 3-run limit', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-1', 'specify', 'ws-1')
    svc.markPipelineRunning('bp-2', 'plan', 'ws-2')
    svc.markPipelineRunning('bp-3', 'build', 'ws-3')

    const result = svc.admitRun()
    assert.equal(result.ok, false, '4th start must be rejected')
    if (!result.ok) {
      assert.equal(result.activeCount, 3)
    }

    // The user-facing error names the limit (fresh-start path message).
    const message = BlueprintService.runCapErrorMessage()
    assert.ok(
      message.includes(String(MAX_CONCURRENT_BLUEPRINT_RUNS)),
      `error message must name the limit: ${message}`
    )
    assert.ok(/running/i.test(message))
  })

  test('start paths: a 4th fresh start throws the cap error (start-specify path shape)', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-1', 'specify', 'ws-1')
    svc.markPipelineRunning('bp-2', 'specify', 'ws-2')
    svc.markPipelineRunning('bp-3', 'specify', 'ws-3')

    // Mirrors assertRunCap() in BLUEPRINT_START_SPECIFY: fresh starts call
    // admitRun() and throw its message on rejection.
    const admission = svc.admitRun()
    assert.equal(admission.ok, false)
    assert.throws(
      () => {
        if (!admission.ok) throw new Error(BlueprintService.runCapErrorMessage())
      },
      /3 blueprints are already running/
    )
  })

  test('retry/resume path: 4th run rejected, but a held blueprint re-enters its own slot (admitRunUnlessHeld)', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-1', 'specify', 'ws-1')
    svc.markPipelineRunning('bp-2', 'specify', 'ws-2')
    svc.markPipelineRunning('bp-3', 'review', 'ws-3')

    // A DIFFERENT blueprint's retry/resume is still a 4th slot → rejected.
    assert.equal(svc.admitRunUnlessHeld('bp-4').ok, false)

    // Gate-park bp-3 (review → awaiting-approval holds its slot) and retry IT.
    const machine = svc.getMachine('bp-3')
    machine.transition('approvalNeeded')
    assert.equal(machine.currentState, 'awaiting-approval')
    assert.equal(svc.countHeldSlots(), 3, 'awaiting-approval still holds a slot')
    // Re-entering its own slot is exempt from the cap.
    assert.deepEqual(svc.admitRunUnlessHeld('bp-3'), { ok: true })
  })
})

describe('BlueprintService — slot semantics', () => {
  test('awaiting-approval (gate-parked) machine HOLDS a slot', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-gate', 'review', 'ws-1')
    const machine = svc.getMachine('bp-gate')
    machine.transition('approvalNeeded')
    assert.equal(machine.currentState, 'awaiting-approval')
    assert.equal(svc.countHeldSlots(), 1)
  })

  test('awaiting-clarify-questions machine HOLDS a slot', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-q', 'clarify', 'ws-1')
    svc.getMachine('bp-q').transition('questionsParsed')
    assert.equal(svc.countHeldSlots(), 1)
  })

  test('FAILED run frees its slot', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-f', 'specify', 'ws-1')
    assert.equal(svc.countHeldSlots(), 1)
    svc.failPipeline('bp-f', 'boom')
    assert.equal(svc.getMachine('bp-f').currentState, 'failed')
    assert.equal(svc.countHeldSlots(), 0, 'failed run must free its slot')
    assert.deepEqual(svc.admitRun(), { ok: true })
  })

  test('CANCELLED run frees its slot', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-c', 'specify', 'ws-1')
    assert.equal(svc.countHeldSlots(), 1)
    const machine = svc.getMachine('bp-c')
    machine.transition('cancel')
    assert.equal(machine.currentState, 'cancelled')
    assert.equal(svc.countHeldSlots(), 0, 'cancelled run must free its slot')
  })

  test('markPipelineStopped WITHOUT keepGate frees the slot (phaseComplete → idle)', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-s', 'specify', 'ws-1')
    svc.markPipelineStopped('bp-s')
    assert.equal(svc.getMachine('bp-s').currentState, 'idle')
    assert.equal(svc.countHeldSlots(), 0)
  })

  test('DELETING a gate-parked blueprint frees its slot', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-del', 'review', 'ws-1')
    svc.getMachine('bp-del').transition('approvalNeeded')
    assert.equal(svc.countHeldSlots(), 1)

    // delete() resets a non-idle machine (BP-DELETE-MACHINE-RESET, now
    // blueprint-keyed). blueprintRepository.delete is DB-bound; stub it.
    const { blueprintRepository } = require('../../db/repositories/blueprint.repository') as typeof import('../../db/repositories/blueprint.repository')
    const origDelete = blueprintRepository.delete.bind(blueprintRepository)
    ;(blueprintRepository as { delete: (id: string) => void }).delete = () => {}
    try {
      svc.delete('bp-del')
    } finally {
      ;(blueprintRepository as { delete: (id: string) => void }).delete = origDelete
    }
    assert.equal(svc.getMachine('bp-del').currentState, 'idle', 'stranded machine reset')
    assert.equal(svc.countHeldSlots(), 0, 'deleted gate-parked run must free its slot')
  })
})

describe('BlueprintService — same-workspace parallel pipelines', () => {
  test('two pipelines in ONE workspace both markPipelineRunning; aborting one leaves the other signal live', async () => {
    const svc = new BlueprintService()

    // Same workspace, two blueprints — both must start (per-blueprint machines).
    svc.markPipelineRunning('bp-a', 'build', 'ws-same')
    svc.markPipelineRunning('bp-b', 'build', 'ws-same')
    assert.equal(svc.isRunning('bp-a'), true)
    assert.equal(svc.isRunning('bp-b'), true)

    // Workspace-keyed wrapper sees an active run.
    assert.equal(svc.hasRunningInWorkspace('ws-same'), true)

    const signalA = svc.getAbortSignal('bp-a')
    const signalB = svc.getAbortSignal('bp-b')
    assert.ok(signalA instanceof AbortSignal)
    assert.ok(signalB instanceof AbortSignal)

    // Abort A (cancel path aborts its controller) — B must stay live.
    svc.getMachine('bp-a').transition('cancel')
    const stateA = (svc as unknown as { pipelines: Map<string, { abortController: AbortController | null }> }).pipelines.get('bp-a')
    stateA?.abortController?.abort()
    assert.equal(signalA?.aborted, true, 'A aborted')
    assert.equal(signalB?.aborted, false, "B's AbortSignal must stay live")
    assert.equal(svc.isRunning('bp-b'), true, 'B still running')
  })

  test('getActiveBlueprintId returns a running blueprint for the workspace', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-x', 'specify', 'ws-multi')
    assert.equal(svc.getActiveBlueprintId('ws-multi'), 'bp-x')
    assert.equal(svc.getActiveBlueprintId('ws-other'), null)
  })

  test('getRunningSnapshots lists held slots including gate-parked runs', async () => {
    const svc = new BlueprintService()
    svc.markPipelineRunning('bp-r1', 'specify', 'ws-1')
    svc.markPipelineRunning('bp-r2', 'review', 'ws-2')
    svc.getMachine('bp-r2').transition('approvalNeeded')
    const snapshots = svc.getRunningSnapshots()
    const ids = snapshots.map((s) => s.blueprintId).sort()
    assert.deepEqual(ids, ['bp-r1', 'bp-r2'])
    // Snapshot carries the machine state so the UI can flag awaiting-approval.
    const gateSnap = snapshots.find((s) => s.blueprintId === 'bp-r2')
    assert.equal(gateSnap?.machineState, 'awaiting-approval')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
