/**
 * Tests for BugRepository — upsert, getAll, filters, resolve/unresolve, notes.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('BugRepository (skipped — native module unavailable)', () => {
    test('upsertBug() creates new bug', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { bugRepository } = require('../bug.repository')

  const makeBugInput = (overrides: Record<string, unknown> = {}) => ({
    process: 'main' as const,
    severity: 'error' as const,
    errorMessage: `Test error ${Date.now()}-${Math.random()}`,
    appVersion: '1.0.0',
    ...overrides
  })

  describe('BugRepository', () => {
    // ── upsertBug ──

    test('upsertBug() creates new bug on first report', () => {
      const input = makeBugInput({ errorMessage: 'Unique error for create test' })
      const result = bugRepository.upsertBug(input)
      assert.equal(result.isNew, true)
      assert.ok(result.bugId)
    })

    test('upsertBug() increments occurrence_count on duplicate', () => {
      const input = makeBugInput({
        errorMessage: 'Duplicate error test',
        sourceFile: 'dup.ts',
        sourceLine: 42
      })
      const first = bugRepository.upsertBug(input)
      const second = bugRepository.upsertBug(input)
      assert.equal(second.isNew, false)
      assert.equal(second.bugId, first.bugId)

      const bug = bugRepository.getById(first.bugId)
      assert.ok(bug)
      assert.equal(bug.occurrenceCount, 2)
    })

    test('upsertBug() re-opens resolved bug and marks isNew:true', () => {
      const input = makeBugInput({ errorMessage: 'Regression error test' })
      const first = bugRepository.upsertBug(input)
      bugRepository.markResolved(first.bugId)

      const regression = bugRepository.upsertBug(input)
      assert.equal(regression.isNew, true)
      assert.equal(regression.bugId, first.bugId)

      const bug = bugRepository.getById(first.bugId)
      assert.ok(bug)
      assert.equal(bug.isResolved, false)
    })

    test('upsertBug() stores all optional fields', () => {
      const input = makeBugInput({
        errorMessage: 'Full fields bug',
        stackTrace: 'Error: at line 1\n  at line 2',
        sourceFile: 'main.ts',
        sourceLine: 10,
        sourceColumn: 5,
        componentName: 'ChatView',
        activeView: 'chat',
        workspaceId: 'ws-1',
        agentId: 'agent-1',
        osInfo: 'macOS 15.0'
      })
      const result = bugRepository.upsertBug(input)
      const bug = bugRepository.getById(result.bugId)
      assert.ok(bug)
      assert.equal(bug.stackTrace, 'Error: at line 1\n  at line 2')
      assert.equal(bug.sourceFile, 'main.ts')
      assert.equal(bug.sourceLine, 10)
      assert.equal(bug.sourceColumn, 5)
      assert.equal(bug.componentName, 'ChatView')
      assert.equal(bug.activeView, 'chat')
      assert.equal(bug.workspaceId, 'ws-1')
      assert.equal(bug.agentId, 'agent-1')
      assert.equal(bug.osInfo, 'macOS 15.0')
    })

    // ── getAll ──

    test('getAll() returns all bugs', () => {
      const all = bugRepository.getAll()
      assert.ok(all.length >= 1)
    })

    test('getAll() filters by process', () => {
      bugRepository.upsertBug(makeBugInput({ errorMessage: 'renderer-only', process: 'renderer' }))
      const filtered = bugRepository.getAll({ process: 'renderer' })
      assert.ok(filtered.every((b: any) => b.process === 'renderer'))
    })

    test('getAll() filters by isResolved', () => {
      const input = makeBugInput({ errorMessage: 'resolved-filter-test' })
      const result = bugRepository.upsertBug(input)
      bugRepository.markResolved(result.bugId)

      const resolved = bugRepository.getAll({ isResolved: true })
      assert.ok(resolved.some((b: any) => b.id === result.bugId))

      const unresolved = bugRepository.getAll({ isResolved: false })
      assert.ok(!unresolved.some((b: any) => b.id === result.bugId))
    })

    test('getAll() sorts by occurrence_count', () => {
      const all = bugRepository.getAll({ sortBy: 'occurrence_count', sortDir: 'desc' })
      if (all.length >= 2) {
        assert.ok(all[0].occurrenceCount >= all[1].occurrenceCount)
      }
    })

    // ── getById ──

    test('getById() returns bug', () => {
      const result = bugRepository.upsertBug(makeBugInput({ errorMessage: 'getbyid-test' }))
      const bug = bugRepository.getById(result.bugId)
      assert.ok(bug)
      assert.equal(bug.id, result.bugId)
    })

    test('getById() returns null for unknown id', () => {
      const bug = bugRepository.getById('nonexistent')
      assert.equal(bug, null)
    })

    // ── markResolved / markUnresolved ──

    test('markResolved() sets isResolved to true', () => {
      const result = bugRepository.upsertBug(makeBugInput({ errorMessage: 'resolve-test' }))
      bugRepository.markResolved(result.bugId)
      const bug = bugRepository.getById(result.bugId)
      assert.ok(bug)
      assert.equal(bug.isResolved, true)
    })

    test('markUnresolved() sets isResolved to false', () => {
      const result = bugRepository.upsertBug(makeBugInput({ errorMessage: 'unresolve-test' }))
      bugRepository.markResolved(result.bugId)
      bugRepository.markUnresolved(result.bugId)
      const bug = bugRepository.getById(result.bugId)
      assert.ok(bug)
      assert.equal(bug.isResolved, false)
    })

    // ── deleteBug ──

    test('deleteBug() removes bug', () => {
      const result = bugRepository.upsertBug(makeBugInput({ errorMessage: 'delete-test' }))
      bugRepository.deleteBug(result.bugId)
      const bug = bugRepository.getById(result.bugId)
      assert.equal(bug, null)
    })

    // ── updateNote ──

    test('updateNote() sets note on bug', () => {
      const result = bugRepository.upsertBug(makeBugInput({ errorMessage: 'note-test' }))
      bugRepository.updateNote(result.bugId, 'This is a known issue')
      const bug = bugRepository.getById(result.bugId)
      assert.ok(bug)
      assert.equal(bug.note, 'This is a known issue')
    })

    // ── getUnresolvedCount ──

    test('getUnresolvedCount() returns count of unresolved bugs', () => {
      const count = bugRepository.getUnresolvedCount()
      assert.equal(typeof count, 'number')
      assert.ok(count >= 0)
    })
  })
}
