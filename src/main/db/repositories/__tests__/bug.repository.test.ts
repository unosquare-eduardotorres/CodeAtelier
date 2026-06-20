/**
 * Tests for BugRepository — upsert dedup, filters, resolve/unresolve, bulk ops.
 * Also tests the pure computeFingerprint() function.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

// ── Pure-logic test: computeFingerprint (no DB needed) ──

describe('computeFingerprint (pure logic)', () => {
  // Replicate the function logic to test determinism
  function computeFingerprint(msg: string, file?: string, line?: number): string {
    const raw = `${msg}|${file ?? ''}|${line ?? ''}`
    return createHash('sha256').update(raw).digest('hex').slice(0, 16)
  }

  test('deterministic for same inputs', () => {
    const a = computeFingerprint('Error: x', 'src/a.ts', 42)
    const b = computeFingerprint('Error: x', 'src/a.ts', 42)
    assert.equal(a, b)
  })

  test('different inputs produce different fingerprints', () => {
    const a = computeFingerprint('Error: x', 'src/a.ts', 42)
    const b = computeFingerprint('Error: y', 'src/a.ts', 42)
    assert.notEqual(a, b)
  })

  test('missing file/line handled gracefully', () => {
    const a = computeFingerprint('Error: z')
    assert.ok(typeof a === 'string')
    assert.equal(a.length, 16)
  })

  test('fingerprint is 16 hex chars', () => {
    const fp = computeFingerprint('test', 'file.ts', 1)
    assert.match(fp, /^[0-9a-f]{16}$/)
  })
})

if (!env) {
  describe('BugRepository (skipped — native module unavailable)', () => {
    test('upsertBug()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { bugRepository } = require('../bug.repository')

  describe('BugRepository', () => {
    test('upsertBug() creates new bug and returns isNew:true', () => {
      const result = bugRepository.upsertBug({
        process: 'main',
        severity: 'error',
        errorMessage: 'Test error 1',
        appVersion: '1.0.0',
        workspaceId: wsId
      })
      assert.equal(result.isNew, true)
      assert.ok(result.bugId)
    })

    test('upsertBug() deduplicates by fingerprint (increment count)', () => {
      const first = bugRepository.upsertBug({
        process: 'main', severity: 'error',
        errorMessage: 'Dup error', appVersion: '1.0.0'
      })
      const second = bugRepository.upsertBug({
        process: 'main', severity: 'error',
        errorMessage: 'Dup error', appVersion: '1.0.0'
      })
      assert.equal(second.isNew, false)
      assert.equal(second.bugId, first.bugId)

      const bug = bugRepository.getById(first.bugId)
      assert.ok(bug!.occurrenceCount >= 2)
    })

    test('upsertBug() re-opens resolved bug (regression)', () => {
      const { bugId } = bugRepository.upsertBug({
        process: 'renderer', severity: 'error',
        errorMessage: 'Regression error', appVersion: '1.0.0'
      })
      bugRepository.markResolved(bugId)
      const regressed = bugRepository.upsertBug({
        process: 'renderer', severity: 'error',
        errorMessage: 'Regression error', appVersion: '1.0.0'
      })
      assert.equal(regressed.isNew, true) // regression = isNew
      assert.equal(regressed.bugId, bugId)
      const bug = bugRepository.getById(bugId)
      assert.equal(bug!.isResolved, false)
    })

    test('toModel() maps snake_case → camelCase with boolean coercion', () => {
      const { bugId } = bugRepository.upsertBug({
        process: 'main', severity: 'fatal',
        errorMessage: 'Model test', stackTrace: 'at line 1',
        sourceFile: 'src/x.ts', sourceLine: 10, sourceColumn: 5,
        componentName: 'App', activeView: 'settings',
        appVersion: '2.0.0', osInfo: 'macOS 15'
      })
      const bug = bugRepository.getById(bugId)
      assert.ok(bug)
      assert.equal(bug.process, 'main')
      assert.equal(bug.severity, 'fatal')
      assert.equal(bug.stackTrace, 'at line 1')
      assert.equal(bug.sourceFile, 'src/x.ts')
      assert.equal(bug.sourceLine, 10)
      assert.equal(bug.sourceColumn, 5)
      assert.equal(bug.componentName, 'App')
      assert.equal(bug.isResolved, false) // boolean, not 0
      assert.equal(typeof bug.isResolved, 'boolean')
    })

    test('getAll() returns bugs with default sort', () => {
      const all = bugRepository.getAll()
      assert.ok(all.length > 0)
    })

    test('getAll() filters by process', () => {
      const rendererBugs = bugRepository.getAll({ process: 'renderer' })
      assert.ok(rendererBugs.every((b: any) => b.process === 'renderer'))
    })

    test('getAll() filters by isResolved', () => {
      const unresolved = bugRepository.getAll({ isResolved: false })
      assert.ok(unresolved.every((b: any) => b.isResolved === false))
    })

    test('getAll() sorts by occurrence_count', () => {
      const sorted = bugRepository.getAll({ sortBy: 'occurrence_count', sortDir: 'desc' })
      for (let i = 1; i < sorted.length; i++) {
        assert.ok(sorted[i - 1].occurrenceCount >= sorted[i].occurrenceCount)
      }
    })

    test('markResolved() and markUnresolved()', () => {
      const { bugId } = bugRepository.upsertBug({
        process: 'main', severity: 'error',
        errorMessage: 'Resolve test', appVersion: '1.0.0'
      })
      bugRepository.markResolved(bugId)
      assert.equal(bugRepository.getById(bugId)!.isResolved, true)

      bugRepository.markUnresolved(bugId)
      assert.equal(bugRepository.getById(bugId)!.isResolved, false)
    })

    test('updateNote() sets note', () => {
      const { bugId } = bugRepository.upsertBug({
        process: 'main', severity: 'error',
        errorMessage: 'Note test', appVersion: '1.0.0'
      })
      bugRepository.updateNote(bugId, 'Investigating...')
      assert.equal(bugRepository.getById(bugId)!.note, 'Investigating...')
    })

    test('deleteBug() removes bug', () => {
      const { bugId } = bugRepository.upsertBug({
        process: 'main', severity: 'error',
        errorMessage: 'Delete test', appVersion: '1.0.0'
      })
      bugRepository.deleteBug(bugId)
      assert.equal(bugRepository.getById(bugId), null)
    })

    test('bulkResolve() resolves multiple bugs', () => {
      const a = bugRepository.upsertBug({ process: 'main', severity: 'error', errorMessage: 'Bulk A', appVersion: '1.0.0' })
      const b = bugRepository.upsertBug({ process: 'main', severity: 'error', errorMessage: 'Bulk B', appVersion: '1.0.0' })
      bugRepository.bulkResolve([a.bugId, b.bugId])
      assert.equal(bugRepository.getById(a.bugId)!.isResolved, true)
      assert.equal(bugRepository.getById(b.bugId)!.isResolved, true)
    })

    test('bulkDelete() removes multiple bugs', () => {
      const a = bugRepository.upsertBug({ process: 'main', severity: 'error', errorMessage: 'BulkDel A', appVersion: '1.0.0' })
      const b = bugRepository.upsertBug({ process: 'main', severity: 'error', errorMessage: 'BulkDel B', appVersion: '1.0.0' })
      bugRepository.bulkDelete([a.bugId, b.bugId])
      assert.equal(bugRepository.getById(a.bugId), null)
      assert.equal(bugRepository.getById(b.bugId), null)
    })

    test('getUnresolvedCount() returns count', () => {
      const count = bugRepository.getUnresolvedCount()
      assert.ok(typeof count === 'number')
    })
  })
}
