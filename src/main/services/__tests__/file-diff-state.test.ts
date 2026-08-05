/**
 * Unit tests for the FileDiffView state resolver.
 *
 * The three empty states (binary / identical / diff) are the highest-value
 * user-facing part of the diff pane — ReactDiffViewer renders NOTHING when both
 * sides match, which is indistinguishable from a broken pane. This suite pins
 * the branching so a refactor can't silently collapse it.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  describeIdenticalReason,
  resolveDiffState
} from '../../../renderer/src/components/chat/file-diff-state'
import type { FileDiffResult } from '../../../shared/types'

function diff(over: Partial<FileDiffResult> = {}): FileDiffResult {
  return { oldContent: 'a', newContent: 'b', language: 'typescript', ...over }
}

describe('resolveDiffState', () => {
  test('differing_sides_render_the_diff', () => {
    assert.equal(resolveDiffState(diff()), 'diff')
  })

  test('identical_sides_render_the_explicit_empty_state', () => {
    assert.equal(resolveDiffState(diff({ oldContent: 'same', newContent: 'same' })), 'identical')
  })

  test('both_sides_empty_is_identical_not_diff', () => {
    assert.equal(resolveDiffState(diff({ oldContent: '', newContent: '' })), 'identical')
  })

  test('new_file_empty_old_side_still_renders_a_diff', () => {
    assert.equal(resolveDiffState(diff({ oldContent: '', newContent: 'new file' })), 'diff')
  })

  test('binary_wins_over_identical', () => {
    // Binary placeholders are identical by construction — binary must be checked first.
    const d = diff({ oldContent: '(Binary file)', newContent: '(Binary file)', isBinary: true })
    assert.equal(resolveDiffState(d), 'binary')
  })

  test('a_warning_does_not_change_the_state', () => {
    assert.equal(resolveDiffState(diff({ warning: 'could not resolve base' })), 'diff')
  })
})

describe('describeIdenticalReason', () => {
  const identical = (over: Partial<FileDiffResult> = {}): FileDiffResult =>
    diff({ oldContent: 'same', newContent: 'same', ...over })

  test('no_reason_falls_back_to_the_generic_copy', () => {
    // The uncommitted-changes path never sets a reason — the component keeps its
    // own left/right-label wording there.
    assert.equal(describeIdenticalReason(identical()), null)
  })

  test('mode_change_names_the_two_modes', () => {
    const described = describeIdenticalReason(
      identical({ identicalReason: 'mode-change', modeChange: { from: '100644', to: '100755' } })
    )
    assert.ok(described?.title.includes('100644 → 100755'))
    // The mode bit IS in the tree and DOES merge — the copy must not claim otherwise.
    assert.ok(described?.detail.includes('only the file permission changes'))
  })

  test('mode_change_without_modes_still_explains_itself', () => {
    const described = describeIdenticalReason(identical({ identicalReason: 'mode-change' }))
    assert.ok(described?.title.includes('file mode'))
  })

  test('rename_only_says_the_file_moved', () => {
    const described = describeIdenticalReason(identical({ identicalReason: 'rename-only' }))
    assert.ok(described?.title.includes('moved'))
  })

  test('empty_file_is_explained_as_empty_not_as_a_bug', () => {
    const described = describeIdenticalReason(identical({ identicalReason: 'empty-file' }))
    assert.ok(described?.title.toLowerCase().includes('empty'))
    assert.ok(!described?.detail.includes('bug'))
  })

  test('stale_list_tells_the_user_to_refresh', () => {
    const described = describeIdenticalReason(identical({ identicalReason: 'no-diff-entry' }))
    assert.ok(described?.detail.toLowerCase().includes('refresh'))
  })

  test('unexplained_is_labelled_a_bug_not_a_clean_file', () => {
    const described = describeIdenticalReason(identical({ identicalReason: 'unexplained' }))
    assert.ok(described?.detail.includes('bug'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
