/**
 * PARALLEL-RUNS — renderer event isolation (focused-run routing).
 *
 * With multiple blueprints running at once, the renderer store follows ONE
 * focused run. An IPC event whose blueprintId differs from the focused run
 * must mutate NOTHING — no transcript appends, no wave state, no stream
 * accumulation. A misrouted chunk would land in the wrong transcript.
 *
 * The store's subscription handlers can't load outside React (zustand +
 * window.api), so this tests the REAL shipped guard (`resolveFocusedRunAction`
 * + `setFocusedBlueprintId`/`getFocusedBlueprintId` from blueprint.store.ts)
 * driving the exact handler-guard shape used in every safeSubscribe body:
 *
 *   if (resolveFocusedRunAction(focusedBlueprintId, data.blueprintId) === 'drop') return
 *
 * The mutation functions below mirror the store's handler bodies; the guard is
 * the real one.
 *
 * Run: tsx src/renderer/src/store/__tests__/blueprint-run-focus.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'

// blueprint.store imports through the `@renderer/*` alias, which only the
// Vite/tsconfig resolvers know about. Map it for the duration of the require,
// then restore the resolver (same pattern as blueprint-lane-finalize.test.ts).
// The guard functions under test are the REAL shipped ones, not mirrors.
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._resolveFilename = resolver

const resolveFocusedRunAction: (
  focusedId: string | null,
  eventBlueprintId: string
) => 'process' | 'drop' = storeModule.resolveFocusedRunAction
const setFocusedBlueprintId: (id: string | null) => void = storeModule.setFocusedBlueprintId
const getFocusedBlueprintId: () => string | null = storeModule.getFocusedBlueprintId
const resolveBlueprintEventAction: typeof import('../blueprint.store').resolveBlueprintEventAction =
  storeModule.resolveBlueprintEventAction

/** Mirror of the focused run state the store mutates in its handlers. */
interface FocusedRunState {
  chatMessages: Array<{ type: string; content: string }>
  phaseStreamText: Record<string, string>
  waveTasks: Record<string, string>
  runningTasks: Record<string, { taskId: string; description: string }>
  currentPhase: string | null
}

function freshState(): FocusedRunState {
  return {
    chatMessages: [],
    phaseStreamText: {},
    waveTasks: {},
    runningTasks: {},
    currentPhase: null
  }
}

/** Exact guard shape used by every safeSubscribe handler (post workspace guard). */
function guard(focusedId: string | null, eventBlueprintId: string): 'process' | 'drop' {
  return resolveFocusedRunAction(focusedId, eventBlueprintId)
}

describe('resolveFocusedRunAction — the pure routing guard', () => {
  test('null focus processes everything (single-run adopt behavior preserved)', () => {
    assert.equal(guard(null, 'bp-any'), 'process')
  })

  test('matching focus processes', () => {
    assert.equal(guard('bp-a', 'bp-a'), 'process')
  })

  test('sibling blueprint event is dropped', () => {
    assert.equal(guard('bp-a', 'bp-b'), 'drop')
  })

  test('focus state round-trips through the module-level setters', () => {
    setFocusedBlueprintId(null)
    assert.equal(getFocusedBlueprintId(), null)
    setFocusedBlueprintId('bp-focus')
    assert.equal(getFocusedBlueprintId(), 'bp-focus')
    setFocusedBlueprintId(null)
  })
})

describe('event isolation — an IPC event for blueprint B while focused on A mutates no state', () => {
  test('phaseProgress chunk for B never lands in A\u2019s transcript/streams', () => {
    const state = freshState()
    setFocusedBlueprintId('bp-a')
    try {
      // Handler shape: cancelled guard → workspace guard → FOCUS guard → mutate.
      const onPhaseProgress = (data: {
        blueprintId: string
        workspaceId: string
        phase: string
        text: string
      }): void => {
        if (guard(getFocusedBlueprintId(), data.blueprintId) === 'drop') return
        state.phaseStreamText[data.phase] = (state.phaseStreamText[data.phase] ?? '') + data.text
        state.chatMessages.push({ type: 'agent', content: data.text })
      }

      // A's own chunk flows through.
      onPhaseProgress({ blueprintId: 'bp-a', workspaceId: 'ws-1', phase: 'plan', text: 'A-text' })
      // B's chunk (same workspace!) must be dropped by the focus guard.
      onPhaseProgress({ blueprintId: 'bp-b', workspaceId: 'ws-1', phase: 'plan', text: 'B-text' })

      assert.deepEqual(state.chatMessages, [{ type: 'agent', content: 'A-text' }])
      assert.equal(state.phaseStreamText['plan'], 'A-text', 'B text must not accumulate')
    } finally {
      setFocusedBlueprintId(null)
    }
  })

  test('waveTaskStart for B never mutates A\u2019s wave state or running tasks', () => {
    const state = freshState()
    setFocusedBlueprintId('bp-a')
    try {
      const onWaveTaskStart = (data: {
        blueprintId: string
        workspaceId: string
        taskId: string
        description: string
      }): void => {
        if (guard(getFocusedBlueprintId(), data.blueprintId) === 'drop') return
        state.waveTasks[data.taskId] = 'running'
        state.runningTasks[data.taskId] = { taskId: data.taskId, description: data.description }
      }

      onWaveTaskStart({ blueprintId: 'bp-a', workspaceId: 'ws-1', taskId: 'T001', description: 'A task' })
      onWaveTaskStart({ blueprintId: 'bp-b', workspaceId: 'ws-1', taskId: 'T002', description: 'B task' })

      assert.deepEqual(Object.keys(state.waveTasks), ['T001'])
      assert.deepEqual(Object.keys(state.runningTasks), ['T001'])
    } finally {
      setFocusedBlueprintId(null)
    }
  })

  test('phaseComplete for B never appends a system message to A\u2019s transcript', () => {
    const state = freshState()
    setFocusedBlueprintId('bp-a')
    try {
      const onPhaseComplete = (data: {
        blueprintId: string
        workspaceId: string
        phase: string
      }): void => {
        if (guard(getFocusedBlueprintId(), data.blueprintId) === 'drop') return
        state.chatMessages.push({ type: 'system', content: `${data.phase} phase complete` })
        state.currentPhase = null
      }

      state.currentPhase = 'build'
      onPhaseComplete({ blueprintId: 'bp-b', workspaceId: 'ws-1', phase: 'verify' })
      assert.deepEqual(state.chatMessages, [], 'no message from B')
      assert.equal(state.currentPhase, 'build', 'A phase state untouched')

      onPhaseComplete({ blueprintId: 'bp-a', workspaceId: 'ws-1', phase: 'verify' })
      assert.equal(state.chatMessages.length, 1)
    } finally {
      setFocusedBlueprintId(null)
    }
  })

  test('snapshot for B is dropped by the focus guard before any state application', () => {
    setFocusedBlueprintId('bp-a')
    try {
      const applySnapshot = (snap: { blueprintId: string | null; machineState: string }): boolean => {
        const focusId = getFocusedBlueprintId()
        if (focusId !== null && snap.blueprintId && snap.blueprintId !== focusId) return false
        return true // would apply
      }

      assert.equal(applySnapshot({ blueprintId: 'bp-b', machineState: 'awaiting-approval' }), false)
      assert.equal(applySnapshot({ blueprintId: 'bp-a', machineState: 'phase-running' }), true)
      // Snapshot without a blueprint id (legacy) still applies under focus —
      // matches the store's null-blueprintId tolerance.
      assert.equal(applySnapshot({ blueprintId: null, machineState: 'idle' }), true)
    } finally {
      setFocusedBlueprintId(null)
    }
  })

  test('workspace guard still drops cross-workspace events when focus matches (defense in depth)', () => {
    // Focus is blueprint-based; the workspace guard from resolveBlueprintEventAction
    // remains the first line — both must agree for an event to process.
    const eventAllowed = (
      activeWorkspaceId: string | null,
      viewedWorkspaceId: string | null,
      focusedId: string | null,
      ev: { workspaceId: string; blueprintId: string }
    ): boolean => {
      const wsAction = resolveBlueprintEventAction(activeWorkspaceId, viewedWorkspaceId, ev.workspaceId)
      if (wsAction === 'drop') return false
      if (resolveFocusedRunAction(focusedId, ev.blueprintId) === 'drop') return false
      return true
    }

    setFocusedBlueprintId('bp-a')
    try {
      // Same workspace, sibling blueprint → workspace guard passes, focus drops.
      assert.equal(
        eventAllowed('ws-1', 'ws-1', 'bp-a', { workspaceId: 'ws-1', blueprintId: 'bp-b' }),
        false
      )
      // Different workspace entirely → both guards reject.
      assert.equal(
        eventAllowed('ws-1', 'ws-1', 'bp-a', { workspaceId: 'ws-2', blueprintId: 'bp-b' }),
        false
      )
      // Focused blueprint in active workspace → processes.
      assert.equal(
        eventAllowed('ws-1', 'ws-1', 'bp-a', { workspaceId: 'ws-1', blueprintId: 'bp-a' }),
        true
      )
    } finally {
      setFocusedBlueprintId(null)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
