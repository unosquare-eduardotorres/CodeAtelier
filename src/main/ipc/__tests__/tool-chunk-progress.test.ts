/**
 * Regression tests for tool_progress handling in processToolChunk (D2).
 *
 * A progress frame must only ever UPDATE an existing activity row. Minting an
 * id here (the old generateToolId fallback) produced a row that no tool_result
 * could ever close — the phantom "running" tools seen in the incident.
 *
 * Run via the suite (npm run test:unit) — like tool-chunk-processor.test.ts this
 * file needs the electron stub installed by run-tests.ts before it loads.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import { processToolChunk } from '../tool-chunk-processor'
import type { StreamChunk } from '../../services'

const OPTIONS = { agentType: 'chat-agent' }

describe('processToolChunk — tool_progress', () => {
  test('returns null when the chunk carries no toolId (never mints an id)', () => {
    const chunk = { type: 'tool_progress', toolName: 'Bash', elapsedSeconds: 30 } as StreamChunk
    assert.equal(processToolChunk(chunk, OPTIONS), null)
  })

  test('passes the real toolId through unchanged so the result can close it', () => {
    const chunk = {
      type: 'tool_progress',
      toolId: 'toolu_011QxKYijgFCHnjid4teB7bp',
      toolName: 'Bash',
      elapsedSeconds: 30
    } as StreamChunk
    const processed = processToolChunk(chunk, OPTIONS)
    assert.equal(processed?.toolActivity.id, 'toolu_011QxKYijgFCHnjid4teB7bp')
    assert.equal(processed?.toolActivity.status, 'running')
    assert.equal(processed?.toolActivity.elapsedSeconds, 30)
  })

  test('repeated ticks reuse the same id (one row, not one per tick)', () => {
    const ids = [30, 60, 90].map(
      (elapsed) =>
        processToolChunk(
          {
            type: 'tool_progress',
            toolId: 'toolu_stable',
            toolName: 'Bash',
            elapsedSeconds: elapsed
          } as StreamChunk,
          OPTIONS
        )?.toolActivity.id
    )
    assert.deepEqual(ids, ['toolu_stable', 'toolu_stable', 'toolu_stable'])
  })

  test('tool_use without an id still gets a synthesised id (unchanged behaviour)', () => {
    const processed = processToolChunk({ type: 'tool_use', toolName: 'Bash' } as StreamChunk, OPTIONS)
    assert.ok(processed?.toolActivity.id)
    assert.equal(processed?.toolActivity.status, 'running')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
