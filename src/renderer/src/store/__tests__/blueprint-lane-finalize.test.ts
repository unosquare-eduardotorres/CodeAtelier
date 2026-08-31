/**
 * F9 — lane finalize(): completed build lanes snapshot-and-release.
 *
 * During multi-wave BUILD, FIX-B keeps completed lanes alive across waves so
 * their content stays visible — but nothing trimmed them, so each lane's
 * segment array (each segment up to SEGMENT_HARD_CAP_CHARS) plus tool
 * activities grew renderer memory until resetAll() at phase end. finalize()
 * snapshots the flat content/tools and releases the accumulator internals.
 *
 * Also covers the lane-store wiring (finalizeLane) and the un-keyed store's
 * immunity (non-build phases never finalize).
 *
 * Run: tsx src/renderer/src/store/__tests__/blueprint-lane-finalize.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import path from 'node:path'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import type { ToolActivity } from '../../../../shared/types'

// createStreamingStore / blueprint-stream.store import through the `@renderer/*`
// alias, which only the Vite/tsconfig resolvers know about. Map it for the
// duration of the require, then put the resolver back so no other test file is
// affected (same pattern as safety-timeout-orphan.test.ts).
const RENDERER_SRC = path.resolve(__dirname, '../..')
const resolver = (Module as any)._resolveFilename
;(Module as any)._resolveFilename = function (request: string, ...rest: any[]) {
  const mapped = request.startsWith('@renderer/')
    ? path.join(RENDERER_SRC, request.slice('@renderer/'.length))
    : request
  return resolver.call(this, mapped, ...rest)
}
const { createStreamingStore, getFlatContent } = require('../createStreamingStore')
const { useBlueprintLaneStore, useBlueprintStreamStore } = require('../blueprint-stream.store')
;(Module as any)._resolveFilename = resolver

function tool(id: string): ToolActivity {
  return { id, toolName: id, status: 'completed', startedAt: 1 } as ToolActivity
}

describe('createStreamingStore.finalize (F9)', () => {
  test('snapshots flat content + tools, then clears segments/currentContent', () => {
    const store = createStreamingStore()
    store.getState().handleStreamChunk({ type: 'text', content: 'First segment.\n\n' })
    store.getState().handleStreamChunk({ type: 'tool_activity', toolActivity: tool('t-1') })
    store.getState().handleStreamChunk({ type: 'text', content: 'Tail text never flushed.' })

    store.getState().finalize()

    const s = store.getState()
    assert.ok(s.finalSnapshot, 'snapshot must exist after finalize()')
    assert.equal(s.finalSnapshot.content, 'First segment.\n\nTail text never flushed.')
    assert.equal(s.finalSnapshot.toolActivities.length, 1)
    assert.equal(s.finalSnapshot.toolActivities[0].id, 't-1')
    // Accumulator internals released:
    assert.equal(s.segments.length, 0)
    assert.equal(s.currentContent, '')
    assert.equal(s.currentToolActivities.length, 0)
    assert.equal(s.isStreaming, false)
  })

  test('is idempotent — a second finalize() keeps the first snapshot', async () => {
    const store = createStreamingStore()
    store.getState().handleStreamChunk({ type: 'text', content: 'only.' })
    store.getState().finalize()
    const first = store.getState().finalSnapshot
    assert.ok(first)

    // Late chunk + duplicate terminal event must not overwrite the snapshot.
    store.getState().handleStreamChunk({ type: 'text', content: 'late' })
    store.getState().finalize()

    const second = store.getState().finalSnapshot
    assert.equal(second, first, 'snapshot object identity must be stable')
    assert.equal(second.content, 'only.')
  })

  test('reset() clears the snapshot', () => {
    const store = createStreamingStore()
    store.getState().handleStreamChunk({ type: 'text', content: 'x' })
    store.getState().finalize()
    assert.ok(store.getState().finalSnapshot)

    store.getState().reset()

    assert.equal(store.getState().finalSnapshot, null)
    assert.equal(store.getState().segments.length, 0)
  })

  test('finalize() on an empty store produces a null-equivalent empty snapshot', () => {
    const store = createStreamingStore()
    store.getState().finalize()
    const snap = store.getState().finalSnapshot
    assert.ok(snap)
    assert.equal(snap.content, '')
    assert.equal(snap.toolActivities.length, 0)
  })
})

describe('blueprint lane store — finalizeLane (F9)', () => {
  test('finalizes the lane for a terminal task and leaves other lanes alone', () => {
    useBlueprintLaneStore.getState().resetAll()
    const lanes = useBlueprintLaneStore.getState()
    const laneA = lanes.getOrCreateLane('task-a')
    const laneB = lanes.getOrCreateLane('task-b')
    laneA.getState().handleStreamChunk({ type: 'text', content: 'A content' })
    laneB.getState().handleStreamChunk({ type: 'text', content: 'B content' })

    lanes.finalizeLane('task-a')

    assert.ok(laneA.getState().finalSnapshot, 'lane A snapshotted')
    assert.equal(laneA.getState().finalSnapshot.content, 'A content')
    assert.equal(laneB.getState().finalSnapshot, null, 'lane B untouched')
    // Lane A stays registered (FIX-B: content remains visible across waves):
    assert.ok(useBlueprintLaneStore.getState().lanes['task-a'])
  })

  test('finalizeLane is a no-op for an unknown taskId', () => {
    useBlueprintLaneStore.getState().resetAll()
    // Must not throw — a task with no streamed content never got a lane.
    useBlueprintLaneStore.getState().finalizeLane('never-existed')
    assert.equal(Object.keys(useBlueprintLaneStore.getState().lanes).length, 0)
  })

  test('resetAll() clears snapshots along with lanes', () => {
    useBlueprintLaneStore.getState().resetAll()
    const lane = useBlueprintLaneStore.getState().getOrCreateLane('task-x')
    lane.getState().handleStreamChunk({ type: 'text', content: 'x' })
    lane.getState().finalize()
    assert.ok(lane.getState().finalSnapshot)

    useBlueprintLaneStore.getState().resetAll()

    assert.equal(useBlueprintLaneStore.getState().lanes['task-x'], undefined)
    assert.equal(lane.getState().finalSnapshot, null, 'reset() cleared the snapshot')
  })
})

describe('un-keyed blueprint stream store is unaffected by finalize (F9)', () => {
  test('the shared store never auto-finalizes — only explicit reset() clears it', () => {
    useBlueprintStreamStore.getState().reset()
    useBlueprintStreamStore.getState().handleStreamChunk({ type: 'text', content: 'phase text' })
    // Move the buffered text into currentContent (no sentence boundary above):
    useBlueprintStreamStore.getState().flush()

    // No lane terminal event ever touches the un-keyed store:
    useBlueprintLaneStore.getState().finalizeLane('some-task')

    const s = useBlueprintStreamStore.getState()
    assert.equal(s.finalSnapshot, null)
    assert.equal(getFlatContent(s), 'phase text')
    useBlueprintStreamStore.getState().reset()
  })
})

// Only exit when run standalone — in the shared runner the harness's own
// summaryAsync() owns the totals (an unconditional call would exit mid-suite
// and silently truncate every later file).
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
