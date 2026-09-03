/**
 * blueprint-feature-diff.test.ts — E3, the shared whole-feature diff.
 *
 * The contract that matters is the CACHE KEY. Code-review, lead-review and (for
 * the baseline half) verify all ask for the same diff, so memoizing it is free —
 * but HEAD moves during VERIFY→BUILD remediation rounds. A key of
 * `(blueprintId, baseline)` would hand the second review the first review's
 * tree: code that is no longer there, without the fixes that replaced it. HEAD
 * is therefore recomputed on every call and is part of the key.
 *
 * The other pinned contract is the three-way return — `null` (no baseline / git
 * failed), `''` (clean tree), or the capped diff — because verify turns `null`
 * into a `no_git` structural verdict while the reviews just skip the diff.
 *
 * Run: tsx src/main/services/__tests__/blueprint-feature-diff.test.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

const GIT_AVAILABLE = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let env: { db: import('better-sqlite3').Database; wsId: string } | null = null
let blueprintRepository: any
let mod: any

try {
  const helper = require('../../db/repositories/__tests__/db-test-helper')
  env = helper.attachTestDb()
  blueprintRepository = require('../../db/repositories/blueprint.repository').blueprintRepository
  mod = require('../blueprint-feature-diff')
} catch (err) {
  console.log(`⚠ feature-diff setup failed — tests will be skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
  env = null
}

if (!env || !GIT_AVAILABLE) {
  describe('feature diff (skipped)', () => {
    test('assembles a capped diff', () => {}, {
      skipReason: !GIT_AVAILABLE ? 'git not available' : 'no DB'
    })
  })
} else {
  const { assembleFeatureDiff, resolveFeatureBaseline, _resetFeatureDiffCache } = mod

  function git(args: string[], cwd: string): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' })
  }

  /** A repo with one commit, plus a helper to add more. */
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'feature-diff-'))
    git(['init', '-q'], dir)
    git(['config', 'user.email', 'diff@test.local'], dir)
    git(['config', 'user.name', 'Diff Test'], dir)
    git(['config', 'commit.gpgsign', 'false'], dir)
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', 'init'], dir)
    return dir
  }

  function commit(dir: string, file: string, body: string): void {
    writeFileSync(join(dir, file), body)
    git(['add', '-A'], dir)
    git(['commit', '-q', '-m', `add ${file}`], dir)
  }

  /** A blueprint whose buildBaselineCommit is the repo's current HEAD. */
  function seedBlueprint(dir: string): string {
    const bp = blueprintRepository.create({
      workspaceId: env!.wsId,
      title: 'feature diff',
      settingsJson: { buildBaselineCommit: git(['rev-parse', 'HEAD'], dir).trim() }
    })
    return bp.id
  }

  describe('E3 — shared feature diff', () => {
    test('a clean tree returns empty string, not null', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const id = seedBlueprint(dir)
        assert.equal(
          assembleFeatureDiff(id, dir),
          '',
          "'' means 'nothing built, still reviewable'; null means 'no baseline' " +
            'and verify turns that into a no_git structural verdict'
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a commit after the baseline appears in the diff', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const id = seedBlueprint(dir)
        commit(dir, 'b.ts', 'export const b = 2\n')
        const diff = assembleFeatureDiff(id, dir)
        assert.ok(diff && diff.includes('b.ts'), 'the new file must be in the diff')
        assert.ok(diff!.includes('export const b = 2'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    // THE point of the module. A remediation round moves HEAD; a key that
    // ignored HEAD would serve the pre-remediation diff to the next review.
    test('the cache follows HEAD — a new commit invalidates it', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const id = seedBlueprint(dir)
        commit(dir, 'b.ts', 'export const b = 2\n')
        const first = assembleFeatureDiff(id, dir)
        assert.ok(first && !first.includes('c.ts'))

        // VERIFY→BUILD remediation lands another commit.
        commit(dir, 'c.ts', 'export const c = 3\n')
        const second = assembleFeatureDiff(id, dir)
        assert.ok(
          second && second.includes('c.ts'),
          'a stale cache here reviews a tree that no longer exists'
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('repeated calls at the same HEAD are served from cache', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const id = seedBlueprint(dir)
        commit(dir, 'b.ts', 'export const b = 2\n')
        const first = assembleFeatureDiff(id, dir)
        const second = assembleFeatureDiff(id, dir)
        assert.equal(second, first)
        // Identity, not just equality: a cache hit returns the same string.
        assert.ok(Object.is(first, second), 'the second call must not re-run git diff')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('the cap truncates with an explicit marker', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const id = seedBlueprint(dir)
        commit(dir, 'big.ts', 'x'.repeat(5_000) + '\n')
        const diff = assembleFeatureDiff(id, dir, 500)
        assert.ok(diff && diff.length <= 500 + 40)
        assert.ok(diff!.includes('(diff truncated for review)'), 'truncation must be visible')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('an unknown blueprint yields null, not a throw', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        assert.equal(resolveFeatureBaseline('bp-does-not-exist', dir), null)
        assert.equal(assembleFeatureDiff('bp-does-not-exist', dir), null)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('a non-git directory yields null rather than throwing', () => {
      _resetFeatureDiffCache()
      const dir = mkdtempSync(join(tmpdir(), 'not-a-repo-'))
      try {
        // No baseline on the blueprint and no git → merge-base fails → null,
        // which verify's structural gate reports as `no_git`.
        const bp = blueprintRepository.create({ workspaceId: env!.wsId, title: 'no git' })
        assert.equal(resolveFeatureBaseline(bp.id, dir), null)
        assert.equal(assembleFeatureDiff(bp.id, dir), null)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    test('an explicit baseline on the blueprint beats the merge-base fallback', () => {
      _resetFeatureDiffCache()
      const dir = makeRepo()
      try {
        const head = git(['rev-parse', 'HEAD'], dir).trim()
        const id = seedBlueprint(dir)
        assert.equal(resolveFeatureBaseline(id, dir), head)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
}

if (require.main === module) void summaryAsync()
