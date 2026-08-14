/**
 * The renderer's 2-minute safety watchdog — when it may act.
 *
 * The watchdog is the last defence against a wedged main process, and every
 * time it fired in the field it was recovering a genuine backend death. It has
 * exactly one blind spot: an open `ask_user` gate has no backend timeout by
 * design (a human may take arbitrarily long), so silence there proves nothing
 * and the card must not be ripped out from under the user.
 *
 * The load-bearing property is the last group: nothing short of main positively
 * claiming the stream may stop a teardown.
 *
 * Run: tsx src/renderer/src/store/__tests__/safety-timeout-policy.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { needsBackendConfirmation, resolveSafetyTimeout } from '../chat-action-utils'

const base = {
  stillStreaming: true,
  isActiveConversation: true,
  hasOpenQuestion: false,
  backendOwnsStream: null as boolean | null
}

describe('needsBackendConfirmation', () => {
  test('only an open question on the active conversation costs a round-trip', () => {
    assert.equal(
      needsBackendConfirmation({ isActiveConversation: true, hasOpenQuestion: true }),
      true
    )
    assert.equal(
      needsBackendConfirmation({ isActiveConversation: true, hasOpenQuestion: false }),
      false
    )
  })

  test('a background conversation is never deferred', () => {
    // pendingQuestions is active-conversation state — a background timeout has
    // no card on screen to protect.
    assert.equal(
      needsBackendConfirmation({ isActiveConversation: false, hasOpenQuestion: true }),
      false
    )
  })
})

describe('resolveSafetyTimeout', () => {
  test('a conversation that stopped streaming is left alone', () => {
    assert.equal(resolveSafetyTimeout({ ...base, stillStreaming: false }), 'ignore')
  })

  test('ordinary silence tears down with no round-trip', () => {
    assert.equal(resolveSafetyTimeout(base), 'teardown')
  })

  test('an open gate defers while main still owns the stream', () => {
    assert.equal(
      resolveSafetyTimeout({ ...base, hasOpenQuestion: true, backendOwnsStream: true }),
      'defer'
    )
  })
})

describe('resolveSafetyTimeout — the watchdog still bites', () => {
  test('an open gate is cleared once main no longer owns the stream', () => {
    assert.equal(
      resolveSafetyTimeout({ ...base, hasOpenQuestion: true, backendOwnsStream: false }),
      'teardown'
    )
  })

  test('a failed streaming-state query does not disarm the watchdog', () => {
    // backendStillOwns() reports a throw as false: an unreachable main process
    // is the exact wedge this timer exists to recover from.
    assert.equal(
      resolveSafetyTimeout({ ...base, hasOpenQuestion: true, backendOwnsStream: false }),
      'teardown'
    )
  })

  test('a gate on a background conversation never defers, whatever main says', () => {
    assert.equal(
      resolveSafetyTimeout({
        ...base,
        isActiveConversation: false,
        hasOpenQuestion: true,
        backendOwnsStream: true
      }),
      'teardown'
    )
  })

  test('an unconsulted backend never defers', () => {
    assert.equal(
      resolveSafetyTimeout({ ...base, hasOpenQuestion: true, backendOwnsStream: null }),
      'teardown'
    )
  })
})

const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('safety-timeout-policy.test.ts')

if (isDirectRun) {
  void summaryAsync()
}
