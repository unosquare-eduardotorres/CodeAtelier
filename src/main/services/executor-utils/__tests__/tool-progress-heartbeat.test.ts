/**
 * Regression tests for the phantom "running" tool rows (D2).
 *
 * CLI 2.1.218 emits tool_progress heartbeats whose `tool_use_id` is a synthetic
 * "<realId>-heartbeat-N" — unique per 30s tick and matching neither the
 * originating tool_use nor the closing tool_result. Correlating on it made
 * every tick look like a brand-new running tool ("22 tools (20 running)" with
 * zero live child processes).
 *
 * Frames below are the captured NDJSON from the incident, verbatim apart from
 * the tick index / elapsed seconds.
 *
 * Run via the suite (npm run test:unit) — like its siblings this file needs the
 * electron stub installed by run-tests.ts before the module graph loads.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../__tests__/test-harness'
import { normalizeMessage } from '../stream-normalizer'
import type { StreamState } from '../stream-normalizer'
import { ToolTracker } from '../tool-tracker'
import { TokenAccountant } from '../token-accountant'

const REAL_ID = 'toolu_011QxKYijgFCHnjid4teB7bp'

function collect(msg: Record<string, unknown>, tools?: ToolTracker) {
  const t = tools ?? new ToolTracker()
  const state: StreamState = { streamedTextLength: 0 }
  return [...normalizeMessage(msg, t, new TokenAccountant(), state, '/workspace')]
}

function heartbeat(tick: number, elapsed: number): Record<string, unknown> {
  return {
    type: 'tool_progress',
    tool_use_id: `${REAL_ID}-heartbeat-${tick}`,
    parent_tool_use_id: REAL_ID,
    tool_name: 'Bash',
    elapsed_time_seconds: elapsed,
    heartbeat: true
  }
}

describe('tool_progress heartbeat correlation', () => {
  test('all heartbeat ticks normalise to the single stable tool id', () => {
    const ids = [heartbeat(0, 30), heartbeat(1, 60), heartbeat(2, 90)].map((frame) => {
      const chunks = collect(frame)
      assert.equal(chunks.length, 1)
      assert.equal(chunks[0].type, 'tool_progress')
      return chunks[0].toolId
    })
    assert.deepEqual(ids, [REAL_ID, REAL_ID, REAL_ID])
  })

  test('elapsed seconds still ride along with each tick', () => {
    const chunks = collect(heartbeat(1, 60))
    assert.equal(chunks[0].elapsedSeconds, 60)
    assert.equal(chunks[0].content, '60s')
    assert.equal(chunks[0].toolName, 'Bash')
  })

  test('falls back to stripping the -heartbeat-N suffix when parent id is absent', () => {
    const frame = heartbeat(3, 120)
    delete frame.parent_tool_use_id
    const chunks = collect(frame)
    assert.equal(chunks[0].toolId, REAL_ID)
  })

  test('a frame with neither id yields nothing (never uncorrelatable)', () => {
    const chunks = collect({ type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 30 })
    assert.deepEqual(chunks, [])
  })

  test('the tool_use / heartbeat / tool_result triple all share one id', () => {
    const tools = new ToolTracker()
    const useChunks = collect(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          content_block: {
            type: 'tool_use',
            id: REAL_ID,
            name: 'Bash',
            input: { command: 'git fetch' }
          }
        }
      },
      tools
    )
    const progressChunks = collect(heartbeat(0, 30), tools)
    const resultChunks = collect(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: REAL_ID, content: '---done---' }] }
      },
      tools
    )

    assert.equal(useChunks.find((c) => c.type === 'tool_use')?.toolId, REAL_ID)
    assert.equal(progressChunks[0].toolId, REAL_ID)
    assert.equal(resultChunks.find((c) => c.type === 'tool_result')?.toolId, REAL_ID)
    // The result closed the tool — nothing left pending.
    assert.equal(tools.pendingToolCount, 0)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
