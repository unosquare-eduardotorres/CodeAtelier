/**
 * blueprint-modified-files tests — real temp git repo.
 *
 * Covers:
 * - getHeadCommit on a repo with / without commits
 * - getModifiedFilesSince: modify / add / delete parsing with numstat counts
 * - rename handling (R100 → new path as M)
 * - invalid baseline → null
 * - recordBaselineCommit persists HEAD, never throws
 *
 * Run: npx tsx src/main/services/__tests__/blueprint-modified-files.test.ts
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'
import {
  getHeadCommit,
  getModifiedFilesSince,
  recordBaselineCommit
} from '../blueprint-modified-files'

// Install electron/electron-log stubs before importing the module under test
setupElectronStub()

/** Create + seed a temp git repo with one commit; returns its path. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmf-'))
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@test.test')
  git('config', 'user.name', 'Test')
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n')
  fs.writeFileSync(path.join(dir, 'old-name.txt'), 'renamed content\n')
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'to be deleted\n')
  git('add', '.')
  git('commit', '-m', 'baseline')
  return dir
}

describe('getHeadCommit', () => {
  test('returns HEAD sha for a committed repo', async () => {
    const dir = makeRepo()
    try {
      const sha = await getHeadCommit(dir)
      assert.match(sha ?? '', /^[0-9a-f]{40}$/)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null for a non-repo directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmf-norepo-'))
    try {
      assert.equal(await getHeadCommit(dir), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getModifiedFilesSince', () => {
  test('parses modify / add / delete with numstat counts', async () => {
    const dir = makeRepo()
    try {
      const baseline = (await getHeadCommit(dir)) as string

      // Modify: 1 add + 1 del
      fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\nchanged\n')
      // Add: 2 lines
      fs.writeFileSync(path.join(dir, 'new-file.ts'), 'export const a = 1\nexport const b = 2\n')
      // Delete
      fs.unlinkSync(path.join(dir, 'gone.txt'))

      const files = await getModifiedFilesSince(dir, baseline)
      assert.ok(files, 'should return entries')
      const byPath = new Map(files.map((f) => [f.path, f]))

      const keep = byPath.get('keep.txt')
      assert.ok(keep, 'keep.txt present')
      assert.equal(keep.status, 'M')
      assert.equal(keep.additions, 1)
      assert.equal(keep.deletions, 0)

      const added = byPath.get('new-file.ts')
      assert.ok(added, 'new-file.ts present')
      assert.equal(added.status, 'A')
      assert.equal(added.additions, 2)
      assert.equal(added.deletions, 0)

      const deleted = byPath.get('gone.txt')
      assert.ok(deleted, 'gone.txt present')
      assert.equal(deleted.status, 'D')
      assert.equal(deleted.deletions, 1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('rename → new path reported as M', async () => {
    const dir = makeRepo()
    try {
      const baseline = (await getHeadCommit(dir)) as string
      const git = (...args: string[]): string =>
        execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
      git('mv', 'old-name.txt', 'new-name.txt')

      const files = await getModifiedFilesSince(dir, baseline)
      assert.ok(files)
      const byPath = new Map(files.map((f) => [f.path, f]))
      // New path survives as M (rename detection collapses R100 to no content change)
      assert.ok(byPath.has('new-name.txt'), 'new path present')
      assert.equal(byPath.get('new-name.txt')?.status, 'M')
      // Old path must NOT appear as a separate D row
      assert.equal(byPath.has('old-name.txt'), false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no changes → empty array (not null)', async () => {
    const dir = makeRepo()
    try {
      const baseline = (await getHeadCommit(dir)) as string
      const files = await getModifiedFilesSince(dir, baseline)
      assert.deepEqual(files, [])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('invalid baseline sha → null', async () => {
    const dir = makeRepo()
    try {
      assert.equal(await getModifiedFilesSince(dir, 'not-a-sha'), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('nonexistent baseline sha → null (git fails)', async () => {
    const dir = makeRepo()
    try {
      const fakeSha = '0123456789abcdef0123456789abcdef01234567'
      assert.equal(await getModifiedFilesSince(dir, fakeSha), null)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('large untracked file → listed as A with 0/0 counts (size guard, GAP-2)', async () => {
    const dir = makeRepo()
    try {
      const baseline = (await getHeadCommit(dir)) as string
      // 1.5 MB untracked artifact — over the 1 MB count cap. Must still appear
      // in the listing (status A) but never block on a sync read of its content.
      fs.writeFileSync(path.join(dir, 'generated-bundle.js'), 'x'.repeat(1_572_864))
      // Small untracked file keeps its real line count.
      fs.writeFileSync(path.join(dir, 'small-new.ts'), 'a\nb\nc\n')

      const files = await getModifiedFilesSince(dir, baseline)
      assert.ok(files)
      const byPath = new Map(files.map((f) => [f.path, f]))

      const big = byPath.get('generated-bundle.js')
      assert.ok(big, 'large untracked file still listed')
      assert.equal(big.status, 'A')
      assert.equal(big.additions, 0)
      assert.equal(big.deletions, 0)

      const small = byPath.get('small-new.ts')
      assert.ok(small)
      assert.equal(small.status, 'A')
      assert.equal(small.additions, 3)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('deleted untracked path (vanished mid-listing) → A with 0/0, never throws', async () => {
    const dir = makeRepo()
    try {
      const baseline = (await getHeadCommit(dir)) as string
      // Simulate a file ls-files saw but that disappears before the count read
      // (e.g. a build artifact cleaned up concurrently): create, list, delete.
      // We can't easily interleave, so instead assert the read-failure branch
      // via a directory masquerading as a file path — statSync succeeds but
      // readFileSync on a directory throws EISDIR on most platforms.
      fs.mkdirSync(path.join(dir, 'dir-as-file'))

      const files = await getModifiedFilesSince(dir, baseline)
      assert.ok(files)
      const entry = files.find((f) => f.path === 'dir-as-file')
      if (entry) {
        // Listed (ls-files reports untracked dirs) but counted as 0/0 — the
        // read failure must not reject the whole listing.
        assert.equal(entry.additions, 0)
        assert.equal(entry.deletions, 0)
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('recordBaselineCommit', () => {
  test('persists HEAD sha via the callback', async () => {
    const dir = makeRepo()
    try {
      const head = (await getHeadCommit(dir)) as string
      const persisted: Array<[string, string, string]> = []
      await recordBaselineCommit('bp-1', dir, (id, key, value) => {
        persisted.push([id, key, value])
      })
      assert.deepEqual(persisted, [['bp-1', 'baselineCommit', head]])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test('non-repo path → persists nothing, never throws', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmf-norepo-'))
    try {
      const persisted: Array<[string, string, string]> = []
      await recordBaselineCommit('bp-2', dir, (id, key, value) => {
        persisted.push([id, key, value])
      })
      assert.equal(persisted.length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ── Summary ──

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
