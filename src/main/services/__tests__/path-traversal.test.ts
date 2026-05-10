/**
 * Tests for path traversal protection in repo.service.ts
 * Validates that assertWithinRepo blocks ../../ escape attempts.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { assertWithinRepo } from '../repo.service'

// ── Tests ──────────────────────────────────────────────────────────────────

describe('assertWithinRepo \u2014 path traversal protection', () => {
  const repoPath = '/home/user/project'

  test('allows normal relative path', () => {
    const result = assertWithinRepo(repoPath, 'src/index.ts')
    assert.equal(result, '/home/user/project/src/index.ts')
  })

  test('allows nested relative path', () => {
    const result = assertWithinRepo(repoPath, 'src/components/App.tsx')
    assert.equal(result, '/home/user/project/src/components/App.tsx')
  })

  test('allows file at repo root', () => {
    const result = assertWithinRepo(repoPath, 'package.json')
    assert.equal(result, '/home/user/project/package.json')
  })

  test('blocks ../../etc/passwd traversal', () => {
    assert.throws(() => assertWithinRepo(repoPath, '../../etc/passwd'), /Path traversal denied/)
  })

  test('blocks ../ traversal one level up', () => {
    assert.throws(
      () => assertWithinRepo(repoPath, '../other-project/secrets.env'),
      /Path traversal denied/
    )
  })

  test('blocks absolute path outside repo', () => {
    assert.throws(() => assertWithinRepo(repoPath, '/etc/passwd'), /Path traversal denied/)
  })

  test('blocks mixed traversal in middle of path', () => {
    assert.throws(() => assertWithinRepo(repoPath, 'src/../../etc/shadow'), /Path traversal denied/)
  })

  test('allows path with ./ prefix (current dir)', () => {
    const result = assertWithinRepo(repoPath, './src/index.ts')
    assert.equal(result, '/home/user/project/src/index.ts')
  })

  test('blocks deeply nested traversal', () => {
    assert.throws(
      () => assertWithinRepo(repoPath, 'src/deep/../../../etc/hosts'),
      /Path traversal denied/
    )
  })
})
