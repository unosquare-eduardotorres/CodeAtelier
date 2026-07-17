/**
 * parse-blocked-by-error.test.ts
 *
 * Pins the parseBlockedByError() pure function extracted to chat-action-utils.ts.
 * Covers:
 *   - Known title → parenthetical with quoted title
 *   - Unknown conversation (fallback) → no redundant parenthetical (P1 fix)
 *   - IPC prefix stripping (P5 fix)
 *   - Non-blocked-by errors pass through with IPC prefix stripped
 *   - Regex safety: UUIDs contain no `)`, partial matches ignored
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseBlockedByError } from '../../../renderer/src/store/chat-action-utils'

const CONVERSATIONS = [
  { id: 'conv-aaa-111', title: 'My Debugging Session' },
  { id: 'conv-bbb-222', title: 'API Design Notes' }
]

describe('parseBlockedByError', () => {
  test('known blocker → parenthetical with quoted title', () => {
    const raw =
      'Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-aaa-111)'
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(
      errorMsg,
      'Another chat ("My Debugging Session") is still processing. Please wait for it to complete or stop it first.'
    )
  })

  test('unknown blocker → no parenthetical (P1 fix)', () => {
    const raw =
      'Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-zzz-unknown)'
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(
      errorMsg,
      'Another chat is still processing. Please wait for it to complete or stop it first.'
    )
    // Must NOT contain "(another chat)" — the old redundant wording
    assert.ok(!errorMsg.includes('(another chat)'))
  })

  test('IPC prefix stripped from blocked-by errors', () => {
    const raw =
      "Error invoking remote method 'chat:sendMessage': Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-bbb-222)"
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(
      errorMsg,
      'Another chat ("API Design Notes") is still processing. Please wait for it to complete or stop it first.'
    )
  })

  test('IPC prefix stripped from non-blocked-by errors (P5 fix)', () => {
    const raw =
      "Error invoking remote method 'chat:sendMessage': A message is already being processed in this conversation."
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(errorMsg, 'A message is already being processed in this conversation.')
  })

  test('non-blocked-by error passes through unchanged', () => {
    const raw = 'Network timeout — please try again.'
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(errorMsg, 'Network timeout — please try again.')
  })

  test('empty conversations list → fallback (no parenthetical)', () => {
    const raw =
      'Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-aaa-111)'
    const { errorMsg } = parseBlockedByError(raw, [])
    assert.equal(
      errorMsg,
      'Another chat is still processing. Please wait for it to complete or stop it first.'
    )
  })

  test('empty error string → empty message (pins current behavior)', () => {
    const { errorMsg } = parseBlockedByError('', CONVERSATIONS)
    assert.equal(errorMsg, '')
  })

  test('IPC prefix + unknown blocker → clean fallback, no prefix leakage', () => {
    const raw =
      "Error invoking remote method 'chat:sendMessage': Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-deleted-999)"
    const { errorMsg } = parseBlockedByError(raw, CONVERSATIONS)
    assert.equal(
      errorMsg,
      'Another chat is still processing. Please wait for it to complete or stop it first.'
    )
    assert.ok(!errorMsg.includes('Error invoking remote method'))
  })

  test('blocker title with special markdown chars is escaped', () => {
    const convs = [{ id: 'conv-md', title: '**bold** and `code`' }]
    const raw =
      'Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-md)'
    const { errorMsg } = parseBlockedByError(raw, convs)
    assert.equal(
      errorMsg,
      'Another chat ("\\*\\*bold\\*\\* and \\`code\\`") is still processing. Please wait for it to complete or stop it first.'
    )
  })

  test('blocker title with backslash before markdown char is fully escaped', () => {
    const convs = [{ id: 'conv-bs', title: '\\*paired\\*' }]
    const raw =
      'Another chat is still processing. Please wait for it to complete or stop it first. (blockedBy:conv-bs)'
    const { errorMsg } = parseBlockedByError(raw, convs)
    // \ escaped to \\, * escaped to \* → \\\* in the output
    assert.ok(!errorMsg.includes('Error invoking remote method'))
    assert.ok(errorMsg.startsWith('Another chat ("'))
    assert.ok(errorMsg.includes('\\\\\\*paired\\\\\\*'))
  })
})

summaryAsync()
