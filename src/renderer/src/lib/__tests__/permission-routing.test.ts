/**
 * Whether a permission ALSO leaves a receipt in the transcript.
 *
 * The modal decides every permission, so this predicate can only ever add a
 * second, read-only surface — never remove one. The load-bearing property is
 * that it stays false for anything the transcript on screen cannot anchor: a
 * card written into the wrong conversation would attribute one chat's prompt to
 * another.
 *
 * Run: tsx src/renderer/src/lib/__tests__/permission-routing.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { shouldRecordInline } from '../permission-routing'

const ACTIVE = 'conv-active'

describe('shouldRecordInline — tool permissions', () => {
  test('matching conversation is recorded inline', () => {
    assert.equal(
      shouldRecordInline({ type: 'toolPermission', conversationId: ACTIVE }, ACTIVE),
      true
    )
  })

  test('a different conversation is not recorded', () => {
    assert.equal(
      shouldRecordInline({ type: 'toolPermission', conversationId: 'conv-other' }, ACTIVE),
      false
    )
  })

  test('missing conversationId is not recorded — no transcript to anchor to', () => {
    assert.equal(shouldRecordInline({ type: 'toolPermission' }, ACTIVE), false)
  })

  test('no active conversation is not recorded', () => {
    assert.equal(
      shouldRecordInline({ type: 'toolPermission', conversationId: ACTIVE }, null),
      false
    )
  })
})

describe('shouldRecordInline — every other permission type stays modal-only', () => {
  for (const type of ['elicitation', 'askQuestion', 'mpaApproval']) {
    test(`${type} is not recorded even when the conversation matches`, () => {
      assert.equal(shouldRecordInline({ type, conversationId: ACTIVE }, ACTIVE), false)
    })
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
