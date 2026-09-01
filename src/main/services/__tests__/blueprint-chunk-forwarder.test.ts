/**
 * Unit tests for blueprint-chunk-forwarder.ts — verifies that tool chunks
 * produce full ToolActivity objects via processToolChunk, and that text
 * chunks / control-tool chunks are handled correctly.
 *
 * Regression coverage: editDiffs captured at tool_use time must survive the
 * tool_result emission and the renderer accumulator merge — an explicit
 * `undefined` key in the phaseProgress payload used to clobber them, making
 * edit rows unclickable (no expandable inline diff).
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { forwardBlueprintChunk } from '../blueprint-chunk-forwarder'
import { StreamSegmentAccumulator } from '../../../renderer/src/utils/stream-segment-accumulator'
import type { StreamChunk } from '../agent-base.service'
import type { BlueprintPhaseProgressPayload } from '../../../shared/blueprint-types'
import type { BlueprintChunkForwarderCtx } from '../blueprint-chunk-forwarder'

const baseCtx: BlueprintChunkForwarderCtx = {
  blueprintId: 'bp-123',
  workspaceId: 'ws-456',
  phase: 'plan',
  workspacePath: '/tmp/test-workspace',
  mode: 'plan'
}

/** Helper: collect emissions from a single forwardBlueprintChunk call */
function collect(chunk: StreamChunk, ctx = baseCtx): BlueprintPhaseProgressPayload[] {
  const emitted: BlueprintPhaseProgressPayload[] = []
  forwardBlueprintChunk((_event, payload) => emitted.push(payload), chunk, ctx)
  return emitted
}

describe('forwardBlueprintChunk', () => {
  // ── Text chunks ──

  test('forwards text chunks as-is with no kind', () => {
    const emitted = collect({ type: 'text', content: 'Hello world' })
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].text, 'Hello world')
    assert.equal(emitted[0].kind, undefined)
    assert.equal(emitted[0].toolActivity, undefined)
    assert.equal(emitted[0].blueprintId, 'bp-123')
    assert.equal(emitted[0].workspaceId, 'ws-456')
    assert.equal(emitted[0].phase, 'plan')
  })

  test('ignores empty text chunks', () => {
    const emitted = collect({ type: 'text', content: '' })
    assert.equal(emitted.length, 0)
  })

  test('ignores text chunks with no content', () => {
    const emitted = collect({ type: 'text' })
    assert.equal(emitted.length, 0)
  })

  // ── tool_use chunks ──

  test('tool_use chunk produces running ToolActivity with summarized input', () => {
    const emitted = collect({
      type: 'tool_use',
      toolName: 'Read',
      toolId: 'tool-abc',
      toolInput: JSON.stringify({ file_path: 'src/index.ts', offset: 1, limit: 50 })
    })

    assert.equal(emitted.length, 1)
    const p = emitted[0]
    assert.equal(p.text, 'Read')
    assert.equal(p.kind, 'tool')
    assert.ok(p.toolActivity, 'toolActivity should be present')
    assert.equal(p.toolActivity!.toolName, 'Read')
    assert.equal(p.toolActivity!.status, 'running')
    assert.ok(p.toolActivity!.id, 'should have an id')
    assert.ok(p.toolActivity!.startedAt, 'should have startedAt')
    // File path extraction
    assert.equal(p.toolActivity!.filePath, 'src/index.ts')
  })

  // ── tool_result chunks ──

  test('tool_result chunk produces completed ToolActivity', () => {
    const emitted = collect({
      type: 'tool_result',
      toolName: 'Glob',
      toolId: 'tool-def',
      content: '["src/a.ts","src/b.ts"]'
    })

    assert.equal(emitted.length, 1)
    const p = emitted[0]
    assert.equal(p.text, 'Glob')
    assert.equal(p.kind, 'tool')
    assert.ok(p.toolActivity)
    assert.equal(p.toolActivity!.toolName, 'Glob')
    assert.ok(
      p.toolActivity!.status === 'completed' || p.toolActivity!.status === 'error',
      'status should be completed or error'
    )
    assert.ok(p.toolActivity!.completedAt, 'should have completedAt')
  })

  // ── tool_progress chunks ──

  test('tool_progress chunk produces running ToolActivity with elapsedSeconds', () => {
    const emitted = collect({
      type: 'tool_progress',
      toolName: 'Bash',
      toolId: 'tool-ghi',
      elapsedSeconds: 42
    })

    assert.equal(emitted.length, 1)
    const p = emitted[0]
    assert.equal(p.text, 'Bash')
    assert.equal(p.kind, 'tool')
    assert.ok(p.toolActivity)
    assert.equal(p.toolActivity!.status, 'running')
    assert.equal(p.toolActivity!.elapsedSeconds, 42)
  })

  // ── Control tools are filtered ──

  test('control-actions tool chunks are silently dropped', () => {
    const emitted = collect({
      type: 'tool_use',
      toolName: 'mcp__control-actions__emit_plan',
      toolId: 'tool-ctrl'
    })
    assert.equal(emitted.length, 0, 'control tools should be filtered by processToolChunk')
  })

  // ── Non-tool chunks are ignored ──

  test('thinking chunks are ignored', () => {
    const emitted = collect({ type: 'thinking', content: 'Let me think...' })
    assert.equal(emitted.length, 0)
  })

  test('error chunks are ignored', () => {
    const emitted = collect({ type: 'error', error: 'something broke' })
    assert.equal(emitted.length, 0)
  })

  test('status chunks are ignored', () => {
    const emitted = collect({ type: 'status', content: 'heartbeat' })
    assert.equal(emitted.length, 0)
  })

  // ── Phase / workspace propagation ──

  test('propagates phase and workspace correctly for build mode', () => {
    const emitted = collect(
      {
        type: 'tool_use',
        toolName: 'Write',
        toolId: 'tool-xyz',
        toolInput: JSON.stringify({ file_path: 'src/foo.ts', content: 'bar' })
      },
      { ...baseCtx, phase: 'build', mode: 'build' }
    )

    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].phase, 'build')
    assert.equal(emitted[0].blueprintId, 'bp-123')
    assert.equal(emitted[0].workspaceId, 'ws-456')
  })
})

describe('forwardBlueprintChunk — editDiffs preservation (regression)', () => {
  /** tool_use for an Edit call — diffs extracted from toolInputRaw. */
  const editUse: StreamChunk = {
    type: 'tool_use',
    toolName: 'Edit',
    toolId: 'tool-edit-1',
    toolInputRaw: JSON.stringify({
      file_path: 'src/foo.ts',
      old_string: 'const a = 1',
      new_string: 'const a = 2'
    })
  }

  /** tool_result for the same call — no toolInput/toolInputRaw, so
   *  processToolChunk produces NO editDiffs (the pre-fix clobber vector). */
  const editResult: StreamChunk = {
    type: 'tool_result',
    toolName: 'Edit',
    toolId: 'tool-edit-1',
    content: 'The file src/foo.ts has been updated.'
  }

  test('tool_use payload carries editDiffs extracted from the input', () => {
    const [p] = collect(editUse)
    assert.ok(p.toolActivity, 'toolActivity should be present')
    assert.ok(Array.isArray(p.toolActivity.editDiffs), 'editDiffs array expected')
    assert.equal(p.toolActivity.editDiffs!.length, 1)
    assert.equal(p.toolActivity.editDiffs![0].oldString, 'const a = 1')
    assert.equal(p.toolActivity.editDiffs![0].newString, 'const a = 2')
  })

  test('tool_result payload has NO own-property editDiffs key (clobber vector)', () => {
    const [p] = collect(editResult)
    assert.ok(p.toolActivity, 'toolActivity should be present')
    // The exact bug: an explicit `editDiffs: undefined` key survives Electron's
    // structured clone and clobbers tool_use-captured diffs in the accumulator
    // merge. The key must be absent entirely, not merely undefined.
    assert.equal(
      Object.prototype.hasOwnProperty.call(p.toolActivity, 'editDiffs'),
      false,
      'editDiffs key must not be an own property of the tool_result payload'
    )
    assert.equal(
      Object.prototype.hasOwnProperty.call(p.toolActivity, 'editDiffsOmitted'),
      false,
      'editDiffsOmitted key must not be an own property of the tool_result payload'
    )
  })

  test('accumulator merge preserves editDiffs across tool_use → tool_result', () => {
    const [usePayload] = collect(editUse)
    const [resultPayload] = collect(editResult)

    const acc = new StreamSegmentAccumulator(() => {})
    acc.handleToolActivity(usePayload.toolActivity!)
    acc.handleToolActivity(resultPayload.toolActivity!)

    const tools = acc.getState().currentToolActivities
    assert.equal(tools.length, 1, 'same id — merged into one activity')
    assert.equal(tools[0].status, 'completed', 'result status wins the merge')
    assert.ok(Array.isArray(tools[0].editDiffs), 'editDiffs must survive the merge')
    assert.equal(tools[0].editDiffs![0].newString, 'const a = 2')
  })

  test('accumulator merge skips explicit undefined keys (defense in depth)', () => {
    // Even if some emitter lists editDiffs explicitly as undefined, the
    // accumulator's undefined-skipping merge must not clobber existing values.
    const acc = new StreamSegmentAccumulator(() => {})
    acc.handleToolActivity({
      id: 'tool-edit-2',
      toolName: 'Edit',
      status: 'running',
      startedAt: 1,
      editDiffs: [{ oldString: 'x', newString: 'y' }]
    })
    acc.handleToolActivity({
      id: 'tool-edit-2',
      toolName: 'Edit',
      status: 'completed',
      completedAt: 2,
      editDiffs: undefined
    })

    const tools = acc.getState().currentToolActivities
    assert.equal(tools.length, 1)
    assert.equal(tools[0].status, 'completed')
    assert.ok(Array.isArray(tools[0].editDiffs), 'undefined key must not clobber diffs')
    assert.equal(tools[0].editDiffs![0].oldString, 'x')
  })
})

// Only run summary when this file is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
