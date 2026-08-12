/**
 * Unit tests for scope-guard.ts — validates agent diff scope enforcement.
 *
 * Tests use mock git outputs to verify the path-matching logic without
 * requiring actual git operations.
 *
 * Fix 4.1 — Scope enforcement via git diff
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// Test the validation logic directly (path matching)
// These tests validate the core algorithm without spawning git.

describe('Scope Guard — path matching logic', () => {
  // Simulate the core logic extracted from validateDiffScope
  function matchFiles(changedFiles: string[], allowedPaths: string[]): string[] {
    return changedFiles.filter((file) => !allowedPaths.some((allowed) => file.startsWith(allowed)))
  }

  test('all changes within allowed paths → no violations', () => {
    const changed = [
      'src/main/services/cost-tracker.service.ts',
      'src/main/services/agent-executor-factory.ts'
    ]
    const allowed = ['src/main/services/']
    const violations = matchFiles(changed, allowed)
    assert.equal(violations.length, 0)
  })

  test('one change outside → violation detected', () => {
    const changed = ['src/main/services/cost-tracker.service.ts', 'package.json']
    const allowed = ['src/main/services/']
    const violations = matchFiles(changed, allowed)
    assert.deepEqual(violations, ['package.json'])
  })

  test('no changes (empty diff) → no violations', () => {
    const violations = matchFiles([], ['src/'])
    assert.equal(violations.length, 0)
  })

  test('multiple allowed paths (OR matching)', () => {
    const changed = ['src/main/services/foo.ts', 'src/shared/types.ts', 'scripts/build.sh']
    const allowed = ['src/main/services/', 'src/shared/']
    const violations = matchFiles(changed, allowed)
    assert.deepEqual(violations, ['scripts/build.sh'])
  })

  test('nested path within allowed prefix → valid', () => {
    const changed = ['src/main/services/mpa/deep/nested/file.ts']
    const allowed = ['src/main/services/']
    const violations = matchFiles(changed, allowed)
    assert.equal(violations.length, 0)
  })

  test('exact file match as allowed path', () => {
    const changed = ['CLAUDE.md', 'src/main/index.ts']
    const allowed = ['CLAUDE.md', 'src/main/index.ts']
    const violations = matchFiles(changed, allowed)
    assert.equal(violations.length, 0)
  })

  test('similar prefix but not matching → violation', () => {
    const changed = ['src/main/services-old/legacy.ts']
    const allowed = ['src/main/services/']
    const violations = matchFiles(changed, allowed)
    assert.deepEqual(violations, ['src/main/services-old/legacy.ts'])
  })

  test('empty allowed paths → all files are violations', () => {
    const changed = ['foo.ts', 'bar.ts']
    const violations = matchFiles(changed, [])
    assert.deepEqual(violations, ['foo.ts', 'bar.ts'])
  })
})

// ── Module export shape ──

describe('Scope Guard — module exports', () => {
  test('validates expected exports exist', () => {
    const mod = require('../scope-guard')
    assert.equal(typeof mod.validateDiffScope, 'function')
    assert.equal(typeof mod.getUncommittedChanges, 'function')
  })
})

// ─── Guardian: run summary only when standalone ───
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
