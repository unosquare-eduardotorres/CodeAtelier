/**
 * PARALLEL-RUNS — event isolation through the REAL store subscriptions (c7).
 *
 * Unlike blueprint-run-focus.test.ts (which pins the pure routing predicate),
 * this file registers the store's ACTUAL `registerListeners()` against a
 * mocked `window.api`, captures the real subscription callbacks, focuses
 * blueprint A, then dispatches blueprint-B IPC events through those callbacks.
 *
 * Asserted against the REAL store state (not mirrors):
 *   - B's transcript/wave/stream mutations never land in the focused run
 *   - A's own events still mutate normally (guard didn't over-block)
 *   - the un-keyed blueprint stream store accumulates ONLY A's chunks
 *
 * Run: tsx src/renderer/src/store/__tests__/blueprint-run-isolation-dom.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'

// ── window + document stubs (the store's RAF flush + logger) ──────────────
type Listener = (...args: unknown[]) => void

interface CapturedSubscription {
  label: string
  callback: Listener
}

const captured: CapturedSubscription[] = []

/** Build a window.api mock whose on* methods capture callbacks. */
function buildApiMock(): Record<string, unknown> {
  const on = (label: string): ((cb: Listener) => () => void) => {
    return (cb: Listener): (() => void) => {
      captured.push({ label, callback: cb })
      return () => undefined
    }
  }
  const invoke = (): Promise<unknown> => Promise.resolve(null)
  return {
    onBlueprintPhaseStart: on('onBlueprintPhaseStart'),
    onBlueprintPhaseProgress: on('onBlueprintPhaseProgress'),
    onBlueprintPhaseComplete: on('onBlueprintPhaseComplete'),
    onBlueprintPhaseArtifact: on('onBlueprintPhaseArtifact'),
    onBlueprintApprovalNeeded: on('onBlueprintApprovalNeeded'),
    onBlueprintClarifyAwaitingInput: on('onBlueprintClarifyAwaitingInput'),
    onBlueprintClarifyFindings: on('onBlueprintClarifyFindings'),
    onBlueprintClarifyQuestions: on('onBlueprintClarifyQuestions'),
    onBlueprintClarifyGate: on('onBlueprintClarifyGate'),
    onBlueprintWaveStart: on('onBlueprintWaveStart'),
    onBlueprintWaveTaskStart: on('onBlueprintWaveTaskStart'),
    onBlueprintWaveTaskComplete: on('onBlueprintWaveTaskComplete'),
    onBlueprintWaveComplete: on('onBlueprintWaveComplete'),
    onBlueprintTaskGates: on('onBlueprintTaskGates'),
    onBlueprintStateSync: on('onBlueprintStateSync'),
    onBlueprintPreflightResult: on('onBlueprintPreflightResult'),
    blueprintGetSnapshot: invoke,
    blueprintGetTranscript: invoke,
    blueprintList: invoke,
    blueprintGetDetails: invoke,
    blueprintStartSpecify: invoke,
    blueprintCreate: invoke
  }
}

// Install window/document BEFORE requiring the store (module-scope reads).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any
g.window = { api: buildApiMock() }
g.document = g.document ?? { createElement: () => ({}), addEventListener: () => undefined }
g.requestAnimationFrame =
  g.requestAnimationFrame ?? ((fn: () => void) => setTimeout(fn, 0) as unknown as number)
g.cancelAnimationFrame = g.cancelAnimationFrame ?? (() => undefined)

// ── alias-mapped require of the REAL store modules ─────────────────────────
const RENDERER_SRC = path.resolve(__dirname, '../..')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolver = (Module as any)._resolveFilename
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  const mapped = request.startsWith('@renderer/')
    ? path.join(RENDERER_SRC, request.slice('@renderer/'.length))
    : request
  return resolver.call(this, mapped, ...rest)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeModule = require('../blueprint.store') as any
const laneModule = require('../blueprint-stream.store') as any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._resolveFilename = resolver

const useBlueprintStore = storeModule.useBlueprintStore
const useBlueprintStreamStore = laneModule.useBlueprintStreamStore
const useBlueprintLaneStore = laneModule.useBlueprintLaneStore
const setFocusedBlueprintId = storeModule.setFocusedBlueprintId as (id: string | null) => void

/** Dispatch an event through a captured real subscription. */
function dispatch(label: string, payload: Record<string, unknown>): void {
  const sub = captured.find((c) => c.label === label)
  if (!sub) {
    throw new Error(`no captured subscription for ${label} (captured: ${captured.map((c) => c.label).join(', ')})`)
  }
  sub.callback(payload)
}

describe('blueprint.store registerListeners — focused-run event isolation (c7)', () => {
  // SINGLE sequential test: the harness runs async tests concurrently, but the
  // store/stream singletons + captured window.api callbacks are module-global —
  // parallel scenarios would reset each other's state mid-flight.
  test("sibling events mutate no focused state (events + snapshot); A's own events still apply", async () => {
    // Fresh, isolated state.
    useBlueprintStore.getState().reset()
    useBlueprintStreamStore.getState().reset()
    useBlueprintLaneStore.getState().resetAll()
    setFocusedBlueprintId(null)

    // Register the REAL listeners — captures window.api callbacks.
    const unregister = useBlueprintStore.getState().registerListeners()

    try {
      // Seed the focused run: adopt workspace, focus blueprint A, start phase.
      useBlueprintStore.setState({ activeWorkspaceId: 'ws-1' })
      setFocusedBlueprintId('bp-a')
      dispatch('onBlueprintPhaseStart', {
        blueprintId: 'bp-a',
        workspaceId: 'ws-1',
        phase: 'build'
      })

      let state = useBlueprintStore.getState()
      assert.equal(state.currentPhase, 'build', 'A phaseStart applied')
      assert.equal(state.isRunning, true)

      // A's transcript baseline: one system message from phaseStart.
      const baselineMessages = state.chatMessages.length
      assert.ok(baselineMessages > 0, 'phaseStart produced a transcript line')

      // ── Dispatch SIBLING events (blueprint B, SAME workspace) ──
      dispatch('onBlueprintPhaseProgress', {
        blueprintId: 'bp-b',
        workspaceId: 'ws-1',
        phase: 'plan',
        text: 'B-plan-chunk'
      })
      dispatch('onBlueprintPhaseComplete', {
        blueprintId: 'bp-b',
        workspaceId: 'ws-1',
        phase: 'plan',
        status: 'complete'
      })
      dispatch('onBlueprintWaveTaskStart', {
        blueprintId: 'bp-b',
        workspaceId: 'ws-1',
        wave: 1,
        taskId: 'T777',
        description: 'B task'
      })
      dispatch('onBlueprintApprovalNeeded', {
        blueprintId: 'bp-b',
        workspaceId: 'ws-1',
        planSummary: 'B gate'
      })

      // Let the RAF-buffered stream flush settle.
      await new Promise((r) => setTimeout(r, 30))

      // ── Assert REAL store state unchanged by B's events ──
      state = useBlueprintStore.getState()
      assert.equal(
        state.chatMessages.length,
        baselineMessages,
        "B's events appended nothing to the focused transcript"
      )
      assert.equal(state.currentPhase, 'build', "B's phaseComplete did not touch A's phase")
      assert.deepEqual(
        Object.keys(state.waveTasks),
        [],
        "B's wave task never entered A's wave state"
      )
      assert.deepEqual(
        Object.keys(state.runningTasks),
        [],
        "B's task never entered A's running tasks"
      )
      assert.equal(state.pendingApproval, null, "B's gate did not raise on A's run")

      // ── Assert the REAL stream store accumulated only A-side chunks ──
      // Flush whatever A-side content pends, then verify B's text is absent.
      const bss = useBlueprintStreamStore.getState()
      bss.flush()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const flat = (laneModule.getFlatContent as any)(bss) as string
      assert.ok(
        !flat.includes('B-plan-chunk'),
        `B's chunk must not reach the un-keyed stream store (got: ${JSON.stringify(flat.slice(0, 120))})`
      )

      // ── Control: A's own events STILL mutate (guard didn't over-block) ──
      const aMessagesBefore = useBlueprintStore.getState().chatMessages.length
      dispatch('onBlueprintPhaseProgress', {
        blueprintId: 'bp-a',
        workspaceId: 'ws-1',
        phase: 'build',
        text: 'A-build-chunk'
      })
      await new Promise((r) => setTimeout(r, 30))
      const streamText = useBlueprintStore.getState().phaseStreamText
      assert.ok(
        (streamText['build'] ?? '').includes('A-build-chunk'),
        "A's own chunk flowed through to phaseStreamText"
      )
      assert.equal(
        useBlueprintStore.getState().chatMessages.length,
        aMessagesBefore,
        'raw chunks buffer, not append (no regression)'
      )

      // ── Snapshot isolation: B's whole-state snapshot mutates nothing ──
      const baselinePhase = useBlueprintStore.getState().currentPhase
      const baselineWave = useBlueprintStore.getState().currentWave

      // B's snapshot: high seq, sibling blueprint, awaiting-approval machine.
      dispatch('onBlueprintStateSync', {
        seq: 9999,
        workspaceId: 'ws-1',
        blueprintId: 'bp-b',
        blueprintTitle: 'Sibling',
        running: true,
        machineState: 'awaiting-approval',
        currentPhase: 'review',
        phaseStartedAt: Date.now(),
        clarifyFindings: null,
        clarifyQuestions: null,
        pendingApproval: { blueprintId: 'bp-b', planSummary: 'B gate' },
        wave: { wave: 7, taskCount: 3, tasks: { T999: 'running' } },
        runningTasks: { T999: { taskId: 'T999', description: 'B' } },
        lastError: null
      })
      await new Promise((r) => setTimeout(r, 10))

      const after = useBlueprintStore.getState()
      assert.equal(after.currentPhase, baselinePhase, "B's snapshot kept A's phase")
      assert.equal(after.currentWave, baselineWave, "B's snapshot kept A's wave state")
      assert.equal(after.pendingApproval, null, "B's gate did not raise on A")
      assert.equal(
        Object.keys(after.waveTasks).length,
        0,
        "B's wave tasks did not enter A's wave state"
      )
    } finally {
      unregister()
      setFocusedBlueprintId(null)
      useBlueprintStore.getState().reset()
      useBlueprintStreamStore.getState().reset()
      useBlueprintLaneStore.getState().resetAll()
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
