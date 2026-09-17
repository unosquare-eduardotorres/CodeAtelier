/**
 * PARALLEL-RUNS — global cap enforced on the REAL IPC start paths.
 *
 * c3 pin: with three runs holding slots, invoking the actual registered
 * BLUEPRINT_START_SPECIFY and BLUEPRINT_RETRY_PHASE handlers must reject the
 * 4th run with the user-facing error naming the 3-run limit — and must not
 * dispatch any additional pipeline (held-slot count unchanged).
 *
 * Production path: registers every handler via registerBlueprintIpc (the real
 * wiring), resolves the exact blueprintService singleton the handlers close
 * over (module-children pattern from ipc-blueprint-deep), and invokes through
 * the same invokeHandler the renderer preload uses.
 *
 * SINGLE sequential test: the harness runs async tests CONCURRENTLY and the
 * cap is a process-global count — parallel scenarios would race each other's
 * slot pools.
 */
import assert from 'node:assert/strict'
import { describe, test, afterEach } from './test-harness'
import {
  setupFullMock,
  getMockRepo,
  mockMainWindow,
  tryInvokeHandler,
  evictFromCache
} from './setup-full-mock'

setupFullMock()

// Earlier suite files (e.g. blueprint-run-cap) load blueprint.service bound to
// the REAL repositories; the handlers' closures would then read the real DB
// and never see our mock rows. Evict the cached service + wiring so this
// file's require re-binds them to the active mock layer (the documented
// evictFromCache pattern from setup-full-mock.ts).
evictFromCache('blueprint.service', 'blueprint.ipc.ts')

// Snapshot the module cache: everything this file ADDS is mock-bound (loaded
// while our Module._load interception is active). afterEach evicts those
// additions so later suite files re-load them under their own setups — the
// cache ends up exactly as if this file never ran.
const cacheKeysBeforeRequire = new Set(Object.keys(require.cache))

// Load and register the real IPC wiring (same pattern as blueprint-ipc-body-p26).
const mod = require('../../ipc/blueprint.ipc')
mod.registerBlueprintIpc(mockMainWindow)

/**
 * Resolve the blueprintService singleton through blueprint.ipc's OWN module
 * children — the exact instance the registered handlers close over. A plain
 * require could return a different instance than the one the wiring bound to.
 */
function serviceBoundToIpc(exportName: string): unknown {
  const ipcMod = require.cache[require.resolve('../../ipc/blueprint.ipc')]
  const child = ipcMod?.children.find((c: NodeModule) =>
    c.filename.includes('blueprint.service')
  )
  return (child?.exports as Record<string, unknown> | undefined)?.[exportName] ?? null
}

type CapService = {
  markPipelineRunning: (bp: string, phase: string, ws?: string) => void
  failPipeline: (bp: string, error: string) => void
  countHeldSlots: () => number
  getMachine: (bp: string) => { transition: (e: string) => void; currentState: string }
}

const svc = serviceBoundToIpc('blueprintService') as CapService | null
const wsRepo = getMockRepo('workspace')
const bpRepo = getMockRepo('blueprint')

describe('IPC start paths — 4th concurrent run rejected (production handlers)', () => {
  afterEach(() => {
    // Undo this file's cache footprint: evict every module it added (all
    // mock-bound from loading under our interception) plus the two evicted
    // modules it re-bound. Later files then re-load them under their own
    // environments — most bind real repositories against the live test DB.
    // Harness/mock infrastructure is never evicted (re-requiring it would
    // reset shared spies mid-suite).
    for (const key of Object.keys(require.cache)) {
      if (cacheKeysBeforeRequire.has(key)) continue
      if (key.includes('__db_mock') || key.includes('__tests__')) continue
      if (/src[\\/]main[\\/](ipc|services)/.test(key)) {
        delete require.cache[key]
      }
    }
    evictFromCache('blueprint.service', 'blueprint.ipc.ts')
  })

  test('startSpecify and retryPhase reject the 4th run; held-slot re-entry is exempt', async () => {
    assert.ok(svc, 'blueprintService singleton bound to blueprint.ipc')
    const baseline = svc.countHeldSlots()

    // ── Scenario 1: BLUEPRINT_START_SPECIFY, three slots held ──
    svc.markPipelineRunning('bp-cap-a', 'specify', 'ws-cap')
    svc.markPipelineRunning('bp-cap-b', 'plan', 'ws-cap')
    svc.markPipelineRunning('bp-cap-c', 'build', 'ws-cap')
    assert.equal(svc.countHeldSlots(), baseline + 3, 'three slots held')

    wsRepo.findById.mockReturnValue({ id: 'ws-cap', repoPath: '/tmp/ws-cap', name: 'Cap Ws' })
    bpRepo.findById.mockReturnValue({
      id: 'bp-cap-d',
      workspaceId: 'ws-cap',
      title: 'Fourth run',
      status: 'draft',
      settingsJson: null
    })

    // The REAL registered handler for BLUEPRINT_START_SPECIFY.
    const startResult = await tryInvokeHandler('blueprint:startSpecify', {
      blueprintId: 'bp-cap-d',
      workspaceId: 'ws-cap'
    })
    assert.equal(startResult.ok, false, '4th start must be rejected')
    assert.match(
      (startResult as { error: Error }).error.message,
      /3 blueprints are already running/,
      `startSpecify error names the 3-run limit (got: ${(startResult as { error: Error }).error.message})`
    )
    assert.equal(svc.countHeldSlots(), baseline + 3, 'no additional slot acquired')

    // Free two slots so scenario 2 starts from a clean 3-slot arrangement.
    svc.failPipeline('bp-cap-a', 'cleanup')
    svc.failPipeline('bp-cap-b', 'cleanup')
    svc.failPipeline('bp-cap-c', 'cleanup')
    assert.equal(svc.countHeldSlots(), baseline, 'slots freed')

    // ── Scenario 2: BLUEPRINT_RETRY_PHASE, three slots held, 4th blueprint ──
    svc.markPipelineRunning('bp-cap-e', 'specify', 'ws-cap')
    svc.markPipelineRunning('bp-cap-f', 'clarify', 'ws-cap')
    svc.markPipelineRunning('bp-cap-g', 'review', 'ws-cap')
    assert.equal(svc.countHeldSlots(), baseline + 3)

    // A DIFFERENT blueprint's retry/resume needs a free slot — not held → reject.
    const retryResult = await tryInvokeHandler('blueprint:retryPhase', {
      blueprintId: 'bp-cap-h',
      workspaceId: 'ws-cap'
    })
    assert.equal(retryResult.ok, false, '4th run retry must be rejected')
    assert.match(
      (retryResult as { error: Error }).error.message,
      /3 blueprints are already running/,
      'retryPhase error names the 3-run limit'
    )
    assert.equal(svc.countHeldSlots(), baseline + 3, 'no additional slot acquired')

    // ── Scenario 3: retryPhase on a HELD (gate-parked) blueprint is exempt ──
    // Park bp-cap-g at its approval gate — it still holds its slot.
    const machine = svc.getMachine('bp-cap-g')
    machine.transition('approvalNeeded')
    assert.equal(machine.currentState, 'awaiting-approval')
    assert.equal(svc.countHeldSlots(), baseline + 3, 'gate still holds its slot')

    bpRepo.findById.mockReturnValue({
      id: 'bp-cap-g',
      workspaceId: 'ws-cap',
      title: 'Held run',
      status: 'reviewing',
      currentPhase: 'review',
      settingsJson: null
    })
    const heldResult = await tryInvokeHandler('blueprint:retryPhase', {
      blueprintId: 'bp-cap-g',
      workspaceId: 'ws-cap'
    })
    // Must NOT be the cap error — whatever retryPhase decides about the mocked
    // row, the admission exemption held (the 3-run limit was not the blocker).
    if (!heldResult.ok) {
      assert.doesNotMatch(
        heldResult.error.message,
        /3 blueprints are already running/,
        'held-slot re-entry must be exempt from the cap'
      )
    }
    assert.equal(svc.countHeldSlots(), baseline + 3, 're-entry acquired no EXTRA slot')

    // Cleanup for the rest of the suite process.
    svc.failPipeline('bp-cap-e', 'cleanup')
    svc.failPipeline('bp-cap-f', 'cleanup')
    svc.failPipeline('bp-cap-g', 'cleanup')
    assert.equal(svc.countHeldSlots(), baseline)
  })
})
