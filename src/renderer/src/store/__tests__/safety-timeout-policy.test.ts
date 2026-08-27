/**
 * The renderer's 2-minute safety watchdog — when it may act.
 *
 * The watchdog is the last defence against a wedged main process. It used to
 * tear down on silence alone, on the premise that every field occurrence was a
 * genuine backend death. That premise was falsified: a background conversation
 * running a long tool emitted only `toolActivity` chunks, which never reset the
 * timer, and the teardown clears `activeRequestId` — so the two further minutes
 * main streamed were all rejected and the turn's output was destroyed. Main is
 * now consulted on every timeout.
 *
 * The load-bearing property is the last group: nothing short of main positively
 * claiming the stream may stop a teardown.
 *
 * Run: tsx src/renderer/src/store/__tests__/safety-timeout-policy.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { resolveSafetyTimeout } from '../chat-action-utils'

const base = {
  stillStreaming: true,
  backendOwnsStream: null as boolean | null
}

describe('resolveSafetyTimeout', () => {
  test('a conversation that stopped streaming is left alone', () => {
    assert.equal(resolveSafetyTimeout({ ...base, stillStreaming: false }), 'ignore')
  })

  test('silence defers while main still owns the stream', () => {
    assert.equal(resolveSafetyTimeout({ ...base, backendOwnsStream: true }), 'defer')
  })
})

describe('resolveSafetyTimeout — the watchdog still bites', () => {
  test('a stream main no longer owns is torn down', () => {
    assert.equal(resolveSafetyTimeout({ ...base, backendOwnsStream: false }), 'teardown')
  })

  test('a failed streaming-state query does not disarm the watchdog', () => {
    // backendStillOwns() reports a throw as false: an unreachable main process
    // is the exact wedge this timer exists to recover from.
    assert.equal(resolveSafetyTimeout({ ...base, backendOwnsStream: false }), 'teardown')
  })

  test('an unconsulted backend never defers', () => {
    assert.equal(resolveSafetyTimeout({ ...base, backendOwnsStream: null }), 'teardown')
  })

  test('ignore wins over defer — a finished conversation is never re-armed', () => {
    assert.equal(resolveSafetyTimeout({ stillStreaming: false, backendOwnsStream: true }), 'ignore')
  })
})

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('safety-timeout-policy.test.ts')

if (isDirectRun) {
  void summaryAsync()
}
