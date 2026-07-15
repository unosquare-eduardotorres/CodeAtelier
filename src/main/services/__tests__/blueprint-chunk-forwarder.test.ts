/**
 * Unit tests for blueprint-chunk-forwarder.ts — verifies that tool chunks
 * produce full ToolActivity objects via processToolChunk, and that text
 * chunks / control-tool chunks are handled correctly.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { forwardBlueprintChunk } from '../blueprint-chunk-forwarder'
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

// Only run summary when this file is the entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
