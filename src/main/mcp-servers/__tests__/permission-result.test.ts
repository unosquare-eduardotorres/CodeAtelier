/**
 * Tests for the permission result builder used by the control-actions MCP server.
 *
 * Regression guard: an allow result MUST carry an `updatedInput` key. Emitting
 * `{"behavior":"allow"}` without it is rejected by the Claude CLI — the tool call
 * fails and the turn ends silently with no assistant output.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../services/__tests__/test-harness'
import { buildPermissionResult, PERMISSION_DENIED_MESSAGE } from '../permission-result'

describe('buildPermissionResult', () => {
  test('allow always emits an updatedInput key, even when input is undefined', () => {
    const parsed = JSON.parse(buildPermissionResult(true, undefined))
    assert.equal(parsed.behavior, 'allow')
    assert.ok('updatedInput' in parsed, 'allow result must carry updatedInput')
    assert.deepEqual(parsed.updatedInput, {})
  })

  test('allow round-trips a populated input object', () => {
    const input = { command: 'npm run build', description: 'Build the app', timeout: 120_000 }
    const parsed = JSON.parse(buildPermissionResult(true, input))
    assert.equal(parsed.behavior, 'allow')
    assert.deepEqual(parsed.updatedInput, input)
  })

  test('deny emits behavior + message and no updatedInput', () => {
    const parsed = JSON.parse(buildPermissionResult(false, { command: 'rm -rf /' }))
    assert.equal(parsed.behavior, 'deny')
    assert.equal(parsed.message, PERMISSION_DENIED_MESSAGE)
    assert.equal('updatedInput' in parsed, false, 'deny must not carry updatedInput')
  })

  test('deny uses a custom message when provided (timeout / socket teardown)', () => {
    const parsed = JSON.parse(buildPermissionResult(false, undefined, 'No user response.'))
    assert.equal(parsed.behavior, 'deny')
    assert.equal(parsed.message, 'No user response.')
  })

  test('every output is valid JSON', () => {
    const cases: Array<[boolean, Record<string, unknown> | undefined]> = [
      [true, undefined],
      [true, {}],
      [true, { nested: { a: [1, 2, 3] } }],
      [false, undefined],
      [false, { command: 'ls' }]
    ]
    for (const [approved, input] of cases) {
      const raw = buildPermissionResult(approved, input)
      assert.doesNotThrow(() => JSON.parse(raw), `unparseable result for approved=${approved}`)
    }
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
