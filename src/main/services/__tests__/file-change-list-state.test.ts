/**
 * Unit tests for the FileChangeList state resolver.
 *
 * The left pane answers "what will ship?", so every wrong branch here is a lie
 * the user has no way to detect: the green "no changes" state after a failed
 * listing, or "could not list changes" for an error that came from push/fetch.
 * This suite pins the precedence so neither direction can come back.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { resolveFileListState } from '../../../renderer/src/components/chat/file-change-list-state'
import type { FileListState } from '../../../renderer/src/components/chat/file-change-list-state'

type Input = Parameters<typeof resolveFileListState>[0]

function state(over: Partial<Input> = {}): FileListState {
  return resolveFileListState({
    isGitConfigured: true,
    isLoading: false,
    fileCount: 0,
    error: null,
    ...over
  })
}

describe('resolveFileListState', () => {
  test('no_git_repo_outranks_loading_and_errors', () => {
    assert.equal(
      state({ isGitConfigured: false, isLoading: true, fileCount: 3, error: 'boom' }),
      'git-missing'
    )
  })

  test('loading_an_empty_list_shows_the_spinner_not_the_clean_state', () => {
    assert.equal(state({ isLoading: true }), 'loading')
  })

  test('a_failed_listing_never_renders_as_no_changes', () => {
    assert.equal(state({ error: 'DIFF_LIST_FAILED: git exploded' }), 'list-failed')
  })

  test('an_error_with_rows_still_renders_the_rows', () => {
    // REF_NOT_FOUND keeps its stale list — hiding it behind a full-pane error
    // would throw away the only listing we have.
    assert.equal(state({ fileCount: 2, error: 'Branch not found' }), 'list')
  })

  test('rows_win_over_loading_so_a_refresh_does_not_blank_the_pane', () => {
    assert.equal(state({ fileCount: 2, isLoading: true }), 'list')
  })

  test('clean_repo_with_no_error_is_the_empty_state', () => {
    assert.equal(state(), 'empty')
  })

  test('empty_string_error_is_not_a_failure', () => {
    assert.equal(state({ error: '' }), 'empty')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
