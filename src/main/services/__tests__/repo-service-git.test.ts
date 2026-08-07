/**
 * Integration tests for RepoService against a REAL git repository.
 *
 * Every defect found in both audit rounds of the code-changes panel lived between
 * the pure parsers (well covered) and git itself (not covered at all): renames
 * rendered as 100% additions, mode-only changes rendered as a bland "no
 * differences", untracked files missing from the "all changes" list. Those bugs
 * are invisible to a mocked git, so this suite drives the service against temp
 * repos built with the real binary.
 *
 * Each test owns its own repo — the harness starts async tests concurrently.
 * Skips cleanly when git isn't on PATH.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFile, mkdtemp, rm, writeFile, chmod, mkdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { test, describe, summaryAsync } from './test-harness'
import { repoService } from '../repo.service'

const gitAvailable = spawnSync('git', ['--version']).status === 0
const skip = gitAvailable ? undefined : { skipReason: 'git is not available on PATH' }

type Git = ReturnType<typeof simpleGit>

/** Fresh temp repo with deterministic config, cleaned up afterwards. */
async function withRepo(fn: (git: Git, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'repo-svc-git-'))
  try {
    const git = simpleGit(dir)
    await git.init()
    await git.addConfig('user.email', 'test@example.com')
    await git.addConfig('user.name', 'Code Atelier Test')
    await git.addConfig('commit.gpgsign', 'false')
    // The suite asserts on rename and mode detection — don't inherit the
    // developer's global settings for either.
    await git.addConfig('diff.renames', 'true')
    await git.addConfig('core.fileMode', 'true')
    await fn(git, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function commitAll(git: Git, message: string): Promise<void> {
  await git.add('.')
  await git.commit(message)
}

describe('RepoService × real git — uncommitted mode', () => {
  test(
    'a_rename_carries_its_source_path_and_is_explained_not_shown_as_an_addition',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'a.txt'), 'stable content\n')
        await commitAll(git, 'add a.txt')
        await git.mv('a.txt', 'b.txt')

        const files = await repoService.getUncommittedFileDetails(dir)
        const renamed = files.find((f) => f.filePath === 'b.txt')
        assert.ok(renamed, 'renamed file must appear in the uncommitted list')
        assert.equal(renamed.oldPath, 'a.txt')

        const diff = await repoService.getFileDiff(dir, 'b.txt', renamed.oldPath)
        // Without oldPath the old side comes back empty and the pane claims a
        // 100% addition of a file that existed all along.
        assert.equal(diff.oldContent, 'stable content\n')
        assert.equal(diff.newContent, 'stable content\n')
        assert.equal(diff.identicalReason, 'rename-only')
      })
    },
    skip
  )

  test(
    'a_rename_that_was_also_edited_appears_once_and_still_carries_its_source_path',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'a.txt'), 'stable content\n')
        await commitAll(git, 'add a.txt')
        await git.mv('a.txt', 'b.txt')
        // RM — git status reports this path as renamed AND modified, so the list
        // used to contain two rows for it and the first one had no oldPath.
        await appendFile(join(dir, 'b.txt'), 'edited after the move\n')

        const files = await repoService.getUncommittedFileDetails(dir)
        const rows = files.filter((f) => f.filePath === 'b.txt')
        assert.equal(rows.length, 1, 'a renamed+edited file must produce exactly one row')
        assert.equal(rows[0].changeType, 'modified')
        assert.equal(rows[0].oldPath, 'a.txt')

        const diff = await repoService.getFileDiff(dir, 'b.txt', rows[0].oldPath)
        assert.equal(diff.oldContent, 'stable content\n')
        assert.equal(diff.newContent, 'stable content\nedited after the move\n')
        assert.equal(diff.identicalReason, undefined)
      })
    },
    skip
  )

  test(
    'a_staged_add_that_was_then_edited_appears_once_and_is_badged_as_created',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'seed.txt'), 'seed\n')
        await commitAll(git, 'seed')

        await writeFile(join(dir, 'fresh.txt'), 'first draft\n')
        await git.add('fresh.txt')
        // AM — lands in both created and modified; the stale 'M' row claimed a HEAD
        // side for a file that has never been committed.
        await appendFile(join(dir, 'fresh.txt'), 'second thought\n')

        const files = await repoService.getUncommittedFileDetails(dir)
        const rows = files.filter((f) => f.filePath === 'fresh.txt')
        assert.equal(rows.length, 1, 'an added+edited file must produce exactly one row')
        assert.equal(rows[0].changeType, 'created')

        const diff = await repoService.getFileDiff(dir, 'fresh.txt')
        assert.equal(diff.oldContent, '')
        assert.equal(diff.newContent, 'first draft\nsecond thought\n')
      })
    },
    skip
  )

  test(
    'a_chmod_in_the_working_tree_is_reported_as_a_mode_change_with_both_modes',
    async () => {
      await withRepo(async (git, dir) => {
        const script = join(dir, 'script.sh')
        await writeFile(script, '#!/bin/sh\necho hi\n')
        await commitAll(git, 'add script')
        await chmod(script, 0o755)

        const diff = await repoService.getFileDiff(dir, 'script.sh')
        assert.equal(diff.identicalReason, 'mode-change')
        assert.deepEqual(diff.modeChange, { from: '100644', to: '100755' })
      })
    },
    skip
  )

  test(
    'a_brand_new_empty_file_is_explained_as_empty_not_as_a_bug',
    async () => {
      await withRepo(async (_git, dir) => {
        await writeFile(join(dir, 'placeholder.txt'), '')

        const files = await repoService.getUncommittedFileDetails(dir)
        assert.ok(files.some((f) => f.filePath === 'placeholder.txt' && f.changeType === 'created'))

        const diff = await repoService.getFileDiff(dir, 'placeholder.txt')
        assert.equal(diff.identicalReason, 'empty-file')
        assert.equal(diff.warning, undefined)
      })
    },
    skip
  )

  test(
    'a_deleted_file_keeps_its_old_side_and_is_not_called_identical',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'gone.txt'), 'about to disappear\n')
        await commitAll(git, 'add gone.txt')
        await unlink(join(dir, 'gone.txt'))

        const files = await repoService.getUncommittedFileDetails(dir)
        assert.ok(files.some((f) => f.filePath === 'gone.txt' && f.changeType === 'deleted'))

        const diff = await repoService.getFileDiff(dir, 'gone.txt')
        assert.equal(diff.oldContent, 'about to disappear\n')
        assert.equal(diff.newContent, '')
        assert.equal(diff.identicalReason, undefined)
      })
    },
    skip
  )

  test(
    'a_file_in_a_repo_with_no_commits_does_not_raise_a_warning',
    async () => {
      await withRepo(async (_git, dir) => {
        await writeFile(join(dir, 'first.ts'), 'export const x = 1\n')
        const diff = await repoService.getFileDiff(dir, 'first.ts')
        // No HEAD exists yet — every lookup fails, and warning on that would paint
        // an error banner over every file of a fresh workspace.
        assert.equal(diff.warning, undefined)
        assert.equal(diff.oldContent, '')
        assert.equal(diff.newContent, 'export const x = 1\n')
      })
    },
    skip
  )

  // Regression guard for "+868 −867 with every line identical": under
  // core.autocrlf the object database holds LF while the checkout holds CRLF,
  // so the blob side and the working-tree side differ on EVERY line.
  test(
    'a_one_line_edit_in_a_crlf_checkout_shows_only_that_line_as_changed',
    async () => {
      await withRepo(async (git, dir) => {
        await git.addConfig('core.autocrlf', 'true')
        const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`)
        await writeFile(join(dir, 'w.csproj'), lines.join('\r\n') + '\r\n')
        await commitAll(git, 'add crlf file')

        lines[7] = 'line 7 CHANGED'
        await writeFile(join(dir, 'w.csproj'), lines.join('\r\n') + '\r\n')

        const diff = await repoService.getFileDiff(dir, 'w.csproj')
        const oldLines = diff.oldContent.split('\n')
        const newLines = diff.newContent.split('\n')
        assert.equal(oldLines.length, newLines.length, 'both sides split to equal line counts')

        const differing = oldLines.filter((l, i) => l !== newLines[i])
        assert.deepEqual(
          differing,
          ['line 7'],
          `exactly one line must differ — got ${differing.length}`
        )
        assert.equal(diff.eolChange?.from, 'lf')
        assert.equal(diff.eolChange?.to, 'crlf')
        assert.ok(diff.warning?.includes('Line endings differ'))
      })
    },
    skip
  )

  test(
    'a_pure_line_ending_flip_is_reported_as_eol_only_not_unexplained',
    async () => {
      await withRepo(async (git, dir) => {
        // autocrlf off, so the LF rewrite is a genuine content change git sees.
        await git.addConfig('core.autocrlf', 'false')
        const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`)
        await writeFile(join(dir, 'w.csproj'), lines.join('\r\n') + '\r\n')
        await commitAll(git, 'add crlf file')

        // Same text, LF endings — the whole file would otherwise render red.
        await writeFile(join(dir, 'w.csproj'), lines.join('\n') + '\n')

        const diff = await repoService.getFileDiff(dir, 'w.csproj')
        assert.equal(diff.identicalReason, 'eol-only')
        assert.equal(diff.eolChange?.from, 'crlf')
        assert.equal(diff.eolChange?.to, 'lf')
        // Never the 'unexplained' app-bug banner, and never a silent clean pane.
        assert.equal(diff.oldContent, diff.newContent)
      })
    },
    skip
  )
})

describe('RepoService × real git — ref comparison modes', () => {
  test(
    'a_non_ascii_path_survives_the_file_list_and_resolves_real_content',
    async () => {
      await withRepo(async (git, dir) => {
        await mkdir(join(dir, 'Solutions'))
        const unicodePath = 'Solutions/Café.cs'
        await writeFile(join(dir, unicodePath), 'class Cafe {}\n')
        await commitAll(git, 'add unicode path')
        const baseBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()

        await git.checkoutLocalBranch('feature')
        await writeFile(join(dir, unicodePath), 'class Cafe { int x; }\n')
        await commitAll(git, 'edit unicode path')

        const files = await repoService.getRefDiffFiles(dir, baseBranch, 'HEAD')
        // core.quotePath mangles this into "Solutions/Caf\303\251.cs" without -z,
        // and every later lookup for that path then fails silently.
        assert.deepEqual(
          files.map((f) => f.filePath),
          [unicodePath]
        )

        const diff = await repoService.getRefFileDiff(dir, unicodePath, baseBranch, 'HEAD')
        assert.equal(diff.oldContent, 'class Cafe {}\n')
        assert.equal(diff.newContent, 'class Cafe { int x; }\n')
        assert.equal(diff.identicalReason, undefined)
      })
    },
    skip
  )

  test(
    'untracked_files_are_unioned_into_the_working_tree_comparison',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'tracked.txt'), 'v1\n')
        await commitAll(git, 'base')
        const baseBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim()

        await git.checkoutLocalBranch('feature')
        await writeFile(join(dir, 'tracked.txt'), 'v2\n')
        await writeFile(join(dir, 'brand-new.txt'), 'never staged\n')

        const files = await repoService.getRefDiffFiles(dir, baseBranch, 'WORKING_TREE')
        const paths = files.map((f) => f.filePath).sort()
        // `git diff` alone can't see a file git doesn't track yet, so a mode
        // labelled "all changes" would omit it entirely.
        assert.deepEqual(paths, ['brand-new.txt', 'tracked.txt'])
        assert.equal(files.find((f) => f.filePath === 'brand-new.txt')?.changeType, 'created')
      })
    },
    skip
  )

  test(
    'committing_a_rename_ships_one_move_not_both_sides_of_it',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'a.txt'), 'stable content\n')
        await commitAll(git, 'add a.txt')
        await git.mv('a.txt', 'b.txt')

        // The panel only ever knows a rename by its destination.
        await repoService.commitFiles(dir, ['b.txt'], 'move a to b')

        const nameStatus = await git.raw(['show', '--name-status', '--format=', 'HEAD'])
        assert.match(
          nameStatus,
          /^R\d*\s+a\.txt\s+b\.txt$/m,
          `expected one rename, got: ${nameStatus}`
        )

        // `git commit <pathspec>` ignores the index, so the old path used to
        // survive into HEAD alongside the new one.
        const tree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])
        const paths = tree.split('\n').filter(Boolean)
        assert.deepEqual(paths, ['b.txt'])

        // And the staged deletion used to be left behind, so the panel
        // immediately re-listed "a.txt — deleted".
        const left = await repoService.getUncommittedFileDetails(dir)
        assert.deepEqual(left, [], `working tree must be clean, got: ${JSON.stringify(left)}`)
      })
    },
    skip
  )

  test(
    'a_missing_ref_fails_loudly_instead_of_reporting_an_empty_diff',
    async () => {
      await withRepo(async (git, dir) => {
        await writeFile(join(dir, 'file.txt'), 'content\n')
        await commitAll(git, 'base')

        await assert.rejects(
          () => repoService.getRefDiffFiles(dir, 'origin/does-not-exist', 'HEAD'),
          /REF_NOT_FOUND/
        )
      })
    },
    skip
  )
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
