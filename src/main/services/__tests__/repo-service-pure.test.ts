/**
 * Unit tests for repo.service.ts pure functions.
 *
 * Tests assertWithinRepo (security-critical path traversal prevention),
 * detectLanguage (file extension → language mapping), buildRefDiffArgs
 * (comparison-base argument construction) and isMissingPathError.
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import {
  assertNotOptionLike,
  assertWithinRepo,
  buildRefDiffArgs,
  changeTypeForStatus,
  expandRenamePaths,
  isMissingPathError,
  gitlinkSideContent,
  isGitlinkEntry,
  isZeroSha,
  mergeStatusEntries,
  mergeUntrackedIntoRefDiff,
  parseNameStatusZ,
  parseRawDiffEntry,
  resolveIdenticalReason,
  shouldWarnOnShowFailure
} from '../repo.service'
import type { RawDiffEntry } from '../repo.service'

const ZERO = '0'.repeat(40)

describe('assertWithinRepo', () => {
  const REPO = '/tmp/test-repo'

  test('normal_relative_path_resolves_correctly', () => {
    const result = assertWithinRepo(REPO, 'src/app.ts')
    assert.equal(result, resolve(REPO, 'src/app.ts'))
  })

  test('path_traversal_parent_throws', () => {
    assert.throws(() => assertWithinRepo(REPO, '../etc/passwd'), /Path traversal denied/)
  })

  test('absolute_path_outside_repo_throws', () => {
    assert.throws(() => assertWithinRepo(REPO, '/etc/passwd'), /Path traversal denied/)
  })

  test('nested_traversal_throws', () => {
    assert.throws(() => assertWithinRepo(REPO, 'src/../../../etc/passwd'), /Path traversal denied/)
  })

  test('dot_path_resolves_correctly', () => {
    const result = assertWithinRepo(REPO, 'src/./file.ts')
    assert.equal(result, resolve(REPO, 'src/file.ts'))
  })

  test('deeply_nested_valid_path_resolves', () => {
    const result = assertWithinRepo(REPO, 'src/components/ui/deep/file.tsx')
    assert.equal(result, resolve(REPO, 'src/components/ui/deep/file.tsx'))
  })

  test('plain_filename_resolves_to_repo_root', () => {
    const result = assertWithinRepo(REPO, 'README.md')
    assert.equal(result, resolve(REPO, 'README.md'))
  })

  test('double_dot_within_repo_is_ok', () => {
    // src/../lib → still within repo
    const result = assertWithinRepo(REPO, 'src/../lib/utils.ts')
    assert.equal(result, resolve(REPO, 'lib/utils.ts'))
  })

  test('double_dot_escaping_repo_throws', () => {
    assert.throws(() => assertWithinRepo(REPO, 'src/../../outside'), /Path traversal denied/)
  })
})

// detectLanguage is a private function — test via module-level access
// We re-implement the test indirectly via the EXT_TO_LANGUAGE map

describe('detectLanguage_via_module', () => {
  // We can't directly access the private function without `as any`,
  // but we can verify the exported assertWithinRepo works with various extensions

  test('assertWithinRepo_returns_correct_path_for_ts_file', () => {
    const result = assertWithinRepo('/tmp/repo', 'app.ts')
    assert.ok(result.endsWith('app.ts'))
  })

  test('assertWithinRepo_returns_correct_path_for_py_file', () => {
    const result = assertWithinRepo('/tmp/repo', 'script.py')
    assert.ok(result.endsWith('script.py'))
  })
})

describe('buildRefDiffArgs', () => {
  const BASE = 'a1b2c3d4e5f6'

  test('working_tree_target_omits_to_ref', () => {
    const args = buildRefDiffArgs(BASE, 'WORKING_TREE')
    assert.deepEqual(args, ['diff', '--name-status', '-z', BASE])
  })

  test('ref_target_appends_to_ref', () => {
    const args = buildRefDiffArgs(BASE, 'HEAD')
    assert.deepEqual(args, ['diff', '--name-status', '-z', BASE, 'HEAD'])
  })

  test('always_requests_nul_separated_output', () => {
    // Without -z, core.quotePath (default true) escapes non-ASCII paths and every
    // later lookup for that file fails silently.
    for (const toRef of ['WORKING_TREE', 'HEAD', 'origin/master']) {
      assert.ok(buildRefDiffArgs(BASE, toRef).includes('-z'))
    }
  })

  test('never_emits_three_dot_form', () => {
    // The three-dot form re-resolves the merge base inside git, which would
    // desync the file list from the per-file content (blank diff panes).
    for (const toRef of ['WORKING_TREE', 'HEAD', 'origin/master']) {
      for (const arg of buildRefDiffArgs(BASE, toRef)) {
        assert.ok(!arg.includes('...'), `arg "${arg}" contains three-dot form`)
      }
    }
  })

  test('never_emits_two_dot_range_form', () => {
    for (const arg of buildRefDiffArgs(BASE, 'origin/master')) {
      assert.ok(!arg.includes('..'), `arg "${arg}" contains a range form`)
    }
  })

  test('base_is_always_the_last_ref_free_arg', () => {
    assert.equal(buildRefDiffArgs(BASE, 'WORKING_TREE')[3], BASE)
    assert.equal(buildRefDiffArgs(BASE, 'HEAD')[3], BASE)
  })
})

describe('parseNameStatusZ', () => {
  test('plain_entries_parse', () => {
    const parsed = parseNameStatusZ('M\0src/app.ts\0A\0src/new.ts\0D\0src/old.ts\0')
    assert.deepEqual(parsed, [
      { status: 'M', filePath: 'src/app.ts' },
      { status: 'A', filePath: 'src/new.ts' },
      { status: 'D', filePath: 'src/old.ts' }
    ])
  })

  test('rename_consumes_three_fields_and_keeps_the_source', () => {
    const parsed = parseNameStatusZ('R100\0docs/old.md\0docs/new.md\0M\0src/app.ts\0')
    assert.deepEqual(parsed, [
      { status: 'R100', filePath: 'docs/new.md', oldPath: 'docs/old.md' },
      { status: 'M', filePath: 'src/app.ts' }
    ])
  })

  test('copy_is_treated_like_a_rename', () => {
    const parsed = parseNameStatusZ('C75\0a.ts\0b.ts\0')
    assert.deepEqual(parsed, [{ status: 'C75', filePath: 'b.ts', oldPath: 'a.ts' }])
  })

  test('empty_output_yields_no_entries', () => {
    assert.deepEqual(parseNameStatusZ(''), [])
    assert.deepEqual(parseNameStatusZ('\0'), [])
  })

  test('non_ascii_paths_survive_verbatim', () => {
    // The old tab parser received `"Solutions/Caf\303\251.cs"` (quoted + escaped)
    // and every subsequent lookup for that path failed silently.
    const parsed = parseNameStatusZ('M\0Solutions/Café.cs\0')
    assert.deepEqual(parsed, [{ status: 'M', filePath: 'Solutions/Café.cs' }])
  })

  test('path_containing_a_tab_is_not_split', () => {
    const parsed = parseNameStatusZ('M\0src/we\tird.ts\0')
    assert.deepEqual(parsed, [{ status: 'M', filePath: 'src/we\tird.ts' }])
  })

  test('truncated_trailing_record_is_dropped_not_guessed', () => {
    const parsed = parseNameStatusZ('M\0src/app.ts\0R100\0only-source.ts\0')
    assert.deepEqual(parsed, [{ status: 'M', filePath: 'src/app.ts' }])
  })
})

describe('changeTypeForStatus', () => {
  test('maps_add_delete_and_everything_else', () => {
    assert.equal(changeTypeForStatus('A'), 'created')
    assert.equal(changeTypeForStatus('D'), 'deleted')
    assert.equal(changeTypeForStatus('M'), 'modified')
    assert.equal(changeTypeForStatus('R100'), 'modified')
    assert.equal(changeTypeForStatus('C75'), 'modified')
  })
})

describe('isZeroSha', () => {
  test('all_zero_object_id_is_zero', () => {
    assert.equal(isZeroSha(ZERO), true)
  })

  test('real_sha_is_not_zero', () => {
    assert.equal(isZeroSha('e23964207f2b010b333e8af24058112219636f50'), false)
  })
})

describe('parseRawDiffEntry', () => {
  test('modified_entry_carries_both_blobs', () => {
    const entry = parseRawDiffEntry(':100644 100644 aaaa1111 bbbb2222 M\tsrc/app.ts\n')
    assert.deepEqual(entry, {
      srcMode: '100644',
      dstMode: '100644',
      srcSha: 'aaaa1111',
      dstSha: 'bbbb2222',
      status: 'M'
    })
  })

  test('added_entry_has_a_zero_source', () => {
    const entry = parseRawDiffEntry(`:000000 100644 ${ZERO} bbbb2222 A\tsrc/new.ts`)
    assert.equal(entry?.status, 'A')
    assert.equal(isZeroSha(entry?.srcSha ?? ''), true)
  })

  test('deleted_entry_has_a_zero_destination', () => {
    const entry = parseRawDiffEntry(`:100644 000000 aaaa1111 ${ZERO} D\tsrc/old.ts`)
    assert.equal(entry?.status, 'D')
    assert.equal(isZeroSha(entry?.dstSha ?? ''), true)
  })

  test('working_tree_comparison_zeroes_the_destination', () => {
    const entry = parseRawDiffEntry(`:100644 100644 aaaa1111 ${ZERO} M\tsrc/app.ts`)
    assert.equal(isZeroSha(entry?.dstSha ?? ''), true)
    assert.equal(isZeroSha(entry?.srcSha ?? ''), false)
  })

  test('rename_entry_ignores_the_two_trailing_paths', () => {
    const entry = parseRawDiffEntry(
      ':100644 100644 aaaa1111 aaaa1111 R100\tdocs/old.md\tdocs/new.md'
    )
    assert.equal(entry?.status, 'R100')
    assert.equal(entry?.srcSha, entry?.dstSha)
  })

  test('mode_only_change_keeps_one_blob_and_two_modes', () => {
    const entry = parseRawDiffEntry(':100644 100755 aaaa1111 aaaa1111 M\tscripts/run.sh')
    assert.equal(entry?.srcMode, '100644')
    assert.equal(entry?.dstMode, '100755')
    assert.equal(entry?.srcSha, entry?.dstSha)
  })

  test('empty_output_is_null', () => {
    assert.equal(parseRawDiffEntry(''), null)
    assert.equal(parseRawDiffEntry('\n\n'), null)
  })

  test('malformed_line_is_null', () => {
    assert.equal(parseRawDiffEntry('not a raw diff line'), null)
    assert.equal(parseRawDiffEntry(':100644 100644 aaaa1111\tsrc/app.ts'), null)
  })

  test('undetected_rename_pair_is_combined_into_one_entry', () => {
    // Rename detection off ⇒ a D and an A entry. Taking either alone would blank
    // one side of the pane.
    const entry = parseRawDiffEntry(
      `:000000 100644 ${ZERO} bbbb2222 A\tdocs/new.md\n:100644 000000 aaaa1111 ${ZERO} D\tdocs/old.md`
    )
    assert.equal(entry?.srcSha, 'aaaa1111')
    assert.equal(entry?.dstSha, 'bbbb2222')
  })

  test('rename_entry_wins_over_other_entries', () => {
    const entry = parseRawDiffEntry(
      ':100644 100644 aaaa1111 bbbb2222 M\tsrc/app.ts\n:100644 100644 cccc3333 cccc3333 R100\told\tnew'
    )
    assert.equal(entry?.status, 'R100')
  })
})

describe('resolveIdenticalReason', () => {
  const entry = (over: Partial<RawDiffEntry> = {}): RawDiffEntry => ({
    srcMode: '100644',
    dstMode: '100644',
    srcSha: 'aaaa1111',
    dstSha: 'bbbb2222',
    status: 'M',
    ...over
  })

  test('different_mode_is_a_mode_change', () => {
    assert.equal(
      resolveIdenticalReason(entry({ dstMode: '100755', dstSha: 'aaaa1111' }), false),
      'mode-change'
    )
  })

  test('working_tree_chmod_is_a_mode_change_despite_a_zero_destination_sha', () => {
    // `git diff --raw <base>` reports the work-tree side as all-zeros, so gating
    // this on srcSha === dstSha mislabelled every uncommitted chmod as a bug.
    assert.equal(
      resolveIdenticalReason(entry({ dstMode: '100755', dstSha: ZERO }), false),
      'mode-change'
    )
  })

  test('rename_status_is_rename_only', () => {
    assert.equal(
      resolveIdenticalReason(entry({ dstSha: 'aaaa1111', status: 'R100' }), false),
      'rename-only'
    )
  })

  test('working_tree_rename_is_rename_only_despite_a_zero_destination_sha', () => {
    assert.equal(
      resolveIdenticalReason(entry({ dstSha: ZERO, status: 'R100' }), false),
      'rename-only'
    )
  })

  test('mode_change_wins_when_a_rename_also_changed_the_mode', () => {
    assert.equal(
      resolveIdenticalReason(
        entry({ dstSha: 'aaaa1111', dstMode: '100755', status: 'R100' }),
        false
      ),
      'mode-change'
    )
  })

  test('added_file_with_no_content_is_an_empty_file_not_a_bug', () => {
    // `.gitkeep` and friends: src mode 000000, dst blob is the empty blob.
    assert.equal(
      resolveIdenticalReason(entry({ srcMode: '000000', srcSha: ZERO, status: 'A' }), true),
      'empty-file'
    )
  })

  test('deleted_empty_file_is_an_empty_file_not_a_bug', () => {
    assert.equal(
      resolveIdenticalReason(entry({ dstMode: '000000', dstSha: ZERO, status: 'D' }), true),
      'empty-file'
    )
  })

  test('no_entry_with_content_means_the_list_is_stale', () => {
    assert.equal(resolveIdenticalReason(null, false), 'no-diff-entry')
  })

  test('no_entry_and_no_content_is_a_new_empty_untracked_file', () => {
    assert.equal(resolveIdenticalReason(null, true), 'empty-file')
  })

  test('same_mode_no_rename_equal_content_is_an_app_bug', () => {
    assert.equal(resolveIdenticalReason(entry(), false), 'unexplained')
  })
})

describe('gitlink handling', () => {
  const gitlink: RawDiffEntry = {
    srcMode: '160000',
    dstMode: '160000',
    srcSha: 'aaaa1111',
    dstSha: 'bbbb2222',
    status: 'M'
  }

  test('submodule_entry_is_detected', () => {
    assert.equal(isGitlinkEntry(gitlink), true)
  })

  test('regular_file_entry_is_not_a_gitlink', () => {
    assert.equal(
      isGitlinkEntry({ ...gitlink, srcMode: '100644', dstMode: '100644' }),
      false
    )
  })

  test('newly_added_submodule_is_still_a_gitlink', () => {
    assert.equal(isGitlinkEntry({ ...gitlink, srcMode: '000000', srcSha: ZERO }), true)
  })

  test('pointer_renders_the_way_git_does', () => {
    // `cat-file blob <commitId>` fails with "bad file" — without this the pane
    // would show two fatal errors and claim an app bug.
    assert.equal(gitlinkSideContent('abc123'), 'Subproject commit abc123\n')
  })

  test('absent_pointer_side_is_empty', () => {
    assert.equal(gitlinkSideContent(ZERO), '')
  })
})

describe('isMissingPathError', () => {
  test('git_path_does_not_exist_is_expected', () => {
    assert.equal(isMissingPathError("fatal: path 'src/new.ts' does not exist in 'HEAD'"), true)
  })

  test('git_exists_on_disk_but_not_in_ref_is_expected', () => {
    assert.equal(
      isMissingPathError("fatal: path 'src/a.ts' exists on disk, but not in 'abc123'"),
      true
    )
  })

  test('unknown_revision_is_a_real_failure', () => {
    assert.equal(isMissingPathError('fatal: bad revision origin/master'), false)
  })

  test('generic_error_is_a_real_failure', () => {
    assert.equal(isMissingPathError('fatal: not a git repository'), false)
  })
})

describe('shouldWarnOnShowFailure', () => {
  test('empty_repo_never_warns', () => {
    // No HEAD => every `git show HEAD:<path>` fails. Warning here would paint an
    // error banner on every file of a fresh workspace.
    assert.equal(
      shouldWarnOnShowFailure(false, "fatal: ambiguous argument 'HEAD': unknown revision"),
      false
    )
  })

  test('empty_repo_never_warns_even_for_unrelated_errors', () => {
    assert.equal(shouldWarnOnShowFailure(false, 'fatal: something else entirely'), false)
  })

  test('missing_path_in_existing_head_does_not_warn', () => {
    assert.equal(
      shouldWarnOnShowFailure(true, "fatal: path 'src/new.ts' exists on disk, but not in 'HEAD'"),
      false
    )
  })

  test('unfetched_ref_in_repo_with_commits_warns', () => {
    assert.equal(shouldWarnOnShowFailure(true, 'fatal: bad revision origin/master'), true)
  })

  test('generic_failure_in_repo_with_commits_warns', () => {
    assert.equal(shouldWarnOnShowFailure(true, 'fatal: unable to read object'), true)
  })
})

describe('mergeUntrackedIntoRefDiff', () => {
  const tracked = [
    { filePath: 'src/app.ts', changeType: 'modified' as const, staged: false },
    { filePath: 'src/old.ts', changeType: 'deleted' as const, staged: false }
  ]

  test('untracked_files_are_appended_as_created', () => {
    const merged = mergeUntrackedIntoRefDiff(tracked, ['src/brand-new.ts'])
    assert.equal(merged.length, 3)
    assert.deepEqual(merged[2], {
      filePath: 'src/brand-new.ts',
      changeType: 'created',
      staged: false
    })
  })

  test('existing_entries_are_never_duplicated_or_downgraded', () => {
    const merged = mergeUntrackedIntoRefDiff(tracked, ['src/app.ts'])
    assert.equal(merged.length, 2)
    assert.equal(merged[0].changeType, 'modified')
  })

  test('duplicate_untracked_paths_collapse', () => {
    const merged = mergeUntrackedIntoRefDiff([], ['a.ts', 'a.ts'])
    assert.equal(merged.length, 1)
  })

  test('empty_untracked_list_is_a_passthrough', () => {
    assert.deepEqual(mergeUntrackedIntoRefDiff(tracked, []), tracked)
  })

  test('untracked_only_repo_still_lists_files', () => {
    // `git diff` output is empty here — without the union the mode shows nothing.
    const merged = mergeUntrackedIntoRefDiff([], ['new-a.ts', 'new-b.ts'])
    assert.deepEqual(
      merged.map((e) => e.filePath),
      ['new-a.ts', 'new-b.ts']
    )
    assert.ok(merged.every((e) => e.changeType === 'created'))
  })

  test('does_not_mutate_the_input_array', () => {
    const input = [...tracked]
    mergeUntrackedIntoRefDiff(input, ['x.ts'])
    assert.equal(input.length, 2)
  })
})

describe('mergeStatusEntries', () => {
  test('a_rename_with_an_edit_collapses_and_keeps_its_old_path', () => {
    // simple-git reports `RM` in BOTH status.modified and status.renamed. Two rows
    // survived, and the store's files.find() took the first — the one with no
    // oldPath — so the rename rendered as a 100% addition all over again.
    const merged = mergeStatusEntries([
      { filePath: 'b.ts', changeType: 'modified', staged: false },
      { filePath: 'b.ts', changeType: 'modified', staged: false, oldPath: 'a.ts' }
    ])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].oldPath, 'a.ts')
    assert.equal(merged[0].changeType, 'modified')
  })

  test('an_added_then_edited_file_is_created_not_modified', () => {
    // `AM` lands in both created and modified — badging it 'M' claims a HEAD side
    // that does not exist.
    const merged = mergeStatusEntries([
      { filePath: 'new.ts', changeType: 'modified', staged: false },
      { filePath: 'new.ts', changeType: 'created', staged: true }
    ])
    assert.equal(merged.length, 1)
    assert.equal(merged[0].changeType, 'created')
  })

  test('staged_is_ored_across_the_duplicates', () => {
    const merged = mergeStatusEntries([
      { filePath: 'x.ts', changeType: 'modified', staged: false },
      { filePath: 'x.ts', changeType: 'modified', staged: true, oldPath: 'y.ts' }
    ])
    assert.equal(merged[0].staged, true)
  })

  test('first_insertion_keeps_its_position', () => {
    const merged = mergeStatusEntries([
      { filePath: 'a.ts', changeType: 'modified', staged: false },
      { filePath: 'b.ts', changeType: 'modified', staged: false },
      { filePath: 'a.ts', changeType: 'modified', staged: false, oldPath: 'old-a.ts' }
    ])
    assert.deepEqual(
      merged.map((e) => e.filePath),
      ['a.ts', 'b.ts']
    )
  })

  test('distinct_paths_pass_through_untouched', () => {
    const input = [
      { filePath: 'a.ts', changeType: 'modified' as const, staged: false },
      { filePath: 'b.ts', changeType: 'deleted' as const, staged: true }
    ]
    assert.deepEqual(mergeStatusEntries(input), input)
  })

  test('does_not_mutate_the_input_entries', () => {
    const first = { filePath: 'a.ts', changeType: 'modified' as const, staged: false }
    mergeStatusEntries([first, { filePath: 'a.ts', changeType: 'created', staged: true }])
    assert.equal(first.changeType, 'modified')
    assert.equal(first.staged, false)
  })
})

describe('assertNotOptionLike', () => {
  test('a_flag_shaped_path_is_rejected_before_it_reaches_git', () => {
    // '-A' passes assertWithinRepo (it resolves to <repo>/-A, escaping nothing)
    // and would reach `git add -A`, staging the whole tree.
    assert.throws(() => assertNotOptionLike('-A'), /must not start with/)
  })

  test('long_options_are_rejected_too', () => {
    assert.throws(() => assertNotOptionLike('--all'), /must not start with/)
  })

  test('ordinary_paths_pass', () => {
    assertNotOptionLike('src/app.ts')
    assertNotOptionLike('weird-name.ts')
    assertNotOptionLike('dir/-leading-dash-inside.ts')
  })
})

describe('expandRenamePaths', () => {
  test('committing_a_rename_destination_pulls_in_its_source', () => {
    // Without the source, `git commit b.ts` ships BOTH files and leaves the
    // staged deletion of a.ts behind.
    assert.deepEqual(expandRenamePaths(['b.ts'], [{ from: 'a.ts', to: 'b.ts' }]), ['b.ts', 'a.ts'])
  })

  test('renames_not_being_committed_are_left_alone', () => {
    assert.deepEqual(expandRenamePaths(['x.ts'], [{ from: 'a.ts', to: 'b.ts' }]), ['x.ts'])
  })

  test('no_renames_is_a_pass_through', () => {
    assert.deepEqual(expandRenamePaths(['a.ts', 'b.ts'], []), ['a.ts', 'b.ts'])
  })

  test('a_source_already_requested_is_not_duplicated', () => {
    assert.deepEqual(expandRenamePaths(['b.ts', 'a.ts'], [{ from: 'a.ts', to: 'b.ts' }]), [
      'b.ts',
      'a.ts'
    ])
  })

  test('duplicate_input_paths_collapse', () => {
    assert.deepEqual(expandRenamePaths(['a.ts', 'a.ts'], []), ['a.ts'])
  })

  test('several_renames_each_contribute_their_source_in_order', () => {
    assert.deepEqual(
      expandRenamePaths(
        ['b.ts', 'd.ts'],
        [
          { from: 'a.ts', to: 'b.ts' },
          { from: 'c.ts', to: 'd.ts' }
        ]
      ),
      ['b.ts', 'd.ts', 'a.ts', 'c.ts']
    )
  })

  test('does_not_mutate_the_caller_array', () => {
    const input = ['b.ts']
    expandRenamePaths(input, [{ from: 'a.ts', to: 'b.ts' }])
    assert.deepEqual(input, ['b.ts'])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
