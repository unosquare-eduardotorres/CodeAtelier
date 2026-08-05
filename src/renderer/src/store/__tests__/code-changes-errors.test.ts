/**
 * The loadFiles error mapping behind the Code Changes panel.
 *
 * Every case here feeds the WRAPPED string, because that is the only shape
 * production ever sees: Electron rejects an IPC call as
 * `Error invoking remote method '<channel>': Error: <original message>`.
 * The old inline `msg.startsWith('REF_NOT_FOUND:')` check therefore never fired
 * and the user got the raw wrapper instead of "Branch not found".
 *
 * Run: tsx src/renderer/src/store/__tests__/code-changes-errors.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import { describeLoadFilesError, unwrapIpcError } from '../code-changes-errors'

const wrap = (channel: string, message: string): string =>
  `Error invoking remote method '${channel}': Error: ${message}`

describe('unwrapIpcError', () => {
  test('strips the electron wrapper and the serialized Error prefix', () => {
    assert.equal(unwrapIpcError(wrap('repo:getRefFileDetails', 'boom')), 'boom')
  })

  test('an unwrapped message passes through unchanged', () => {
    assert.equal(unwrapIpcError('boom'), 'boom')
  })

  test('a channel name containing a colon is still matched', () => {
    assert.equal(
      unwrapIpcError(wrap('repo:getFileDetails', 'REF_NOT_FOUND: x')),
      'REF_NOT_FOUND: x'
    )
  })
})

describe('describeLoadFilesError', () => {
  test('a wrapped REF_NOT_FOUND explains the missing branch', () => {
    const { error, clearFiles } = describeLoadFilesError(
      wrap('repo:getRefFileDetails', 'REF_NOT_FOUND: origin/master or HEAD does not exist')
    )
    assert.match(error, /^Branch not found/)
    assert.match(error, /origin\/master or HEAD does not exist/)
    // The list is empty because the ref is unknown, not because it is untrusted.
    assert.equal(clearFiles, false)
  })

  test('a wrapped DIFF_LIST_FAILED warns and discards the list', () => {
    const { error, clearFiles } = describeLoadFilesError(
      wrap('repo:getRefFileDetails', 'DIFF_LIST_FAILED: fatal: unable to read tree')
    )
    assert.match(error, /do not trust this list/)
    assert.match(error, /fatal: unable to read tree/)
    assert.equal(clearFiles, true)
  })

  test('an unwrapped tag is handled too — the store is not the only caller shape', () => {
    assert.match(describeLoadFilesError('REF_NOT_FOUND: develop').error, /^Branch not found/)
  })

  test('an empty DIFF_LIST_FAILED detail still reads as a failure', () => {
    const { error } = describeLoadFilesError(wrap('repo:getFileDetails', 'DIFF_LIST_FAILED: '))
    assert.match(error, /Could not list changes/)
    assert.match(error, /\(\)$/)
  })

  test('an unrecognised failure surfaces unwrapped, not raw', () => {
    const { error, clearFiles } = describeLoadFilesError(
      wrap('repo:getFileDetails', 'EACCES: permission denied')
    )
    assert.equal(error, 'EACCES: permission denied')
    assert.equal(clearFiles, false)
  })

  test('a tag appearing mid-message is not treated as a tagged failure', () => {
    // Only a leading tag is ours — matching anywhere would let arbitrary git
    // output impersonate a known failure mode.
    const { error } = describeLoadFilesError(
      wrap('repo:getFileDetails', 'wrote REF_NOT_FOUND: to log')
    )
    assert.equal(error, 'wrote REF_NOT_FOUND: to log')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
