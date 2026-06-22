/**
 * Unit tests for base-repository.ts — generic CRUD methods.
 *
 * Phase 6A Coverage Improvement — lines 65-83 (deleteBy, deleteById, runTransaction).
 * Uses in-memory SQLite via createTestDb().
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('BaseRepository (skipped — native module unavailable)', () => {
    test('deleteBy removes rows', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db } = env

  // Create a simple test table for the abstract BaseRepository to work with
  db.exec(`
    CREATE TABLE IF NOT EXISTS base_repo_test (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      category TEXT
    )
  `)

  // Concrete subclass for testing
  const { BaseRepository } = require('../../base-repository')

  class TestRepository extends BaseRepository {
    protected readonly tableName = 'base_repo_test'
    protected mapRow(row: any) {
      return { id: row.id, name: row.name, category: row.category }
    }
  }

  const repo = new TestRepository()

  // Seed helper
  function insert(name: string, category?: string): string {
    const row = db
      .prepare('INSERT INTO base_repo_test (name, category) VALUES (?, ?) RETURNING id')
      .get(name, category ?? null) as { id: string }
    return row.id
  }

  describe('BaseRepository.deleteBy', () => {
    test('deletes rows matching column value and returns count', () => {
      insert('delete-target', 'cat-A')
      insert('delete-target', 'cat-A')
      insert('keep-me', 'cat-B')
      const deleted = repo.deleteBy('category', 'cat-A')
      assert.equal(deleted, 2)
      // Verify remaining
      const remaining = repo.findManyBy('category', 'cat-B')
      assert.equal(remaining.length, 1)
      assert.equal(remaining[0].name, 'keep-me')
    })

    test('no matching rows → returns 0', () => {
      const deleted = repo.deleteBy('category', 'nonexistent-category')
      assert.equal(deleted, 0)
    })
  })

  describe('BaseRepository.deleteById', () => {
    test('deletes row by primary key and returns 1', () => {
      const id = insert('to-delete-by-id', 'cat-C')
      const deleted = repo.deleteById(id)
      assert.equal(deleted, 1)
      // Verify gone
      const found = repo.findById(id)
      assert.equal(found, undefined)
    })

    test('nonexistent id → returns 0', () => {
      const deleted = repo.deleteById('no-such-id')
      assert.equal(deleted, 0)
    })
  })

  describe('BaseRepository.runTransaction', () => {
    test('commits on success → rows visible', () => {
      const result = (repo as any).runTransaction(() => {
        const id = insert('txn-row', 'txn')
        return id
      })
      const found = repo.findById(result)
      assert.ok(found, 'row should exist after successful transaction')
      assert.equal(found.name, 'txn-row')
    })

    test('rolls back on error → rows not visible', () => {
      const beforeCount = repo.findManyBy('category', 'rollback-test').length
      try {
        ;(repo as any).runTransaction(() => {
          insert('should-rollback', 'rollback-test')
          throw new Error('force rollback')
        })
      } catch {
        /* expected */
      }
      const afterCount = repo.findManyBy('category', 'rollback-test').length
      assert.equal(afterCount, beforeCount, 'row count should not change after rollback')
    })

    test('returns the function result', () => {
      const result = (repo as any).runTransaction(() => 42)
      assert.equal(result, 42)
    })
  })

  describe('BaseRepository.findOneBy', () => {
    test('returns mapped model for matching row', () => {
      const id = insert('find-one-target', 'find-test')
      const found = repo.findOneBy('id', id)
      assert.ok(found)
      assert.equal(found.id, id)
      assert.equal(found.name, 'find-one-target')
    })

    test('no match → returns undefined', () => {
      const found = repo.findOneBy('id', 'nonexistent')
      assert.equal(found, undefined)
    })
  })

  describe('BaseRepository.findManyBy', () => {
    test('orderBy option sorts results', () => {
      insert('zzz-last', 'order-test')
      insert('aaa-first', 'order-test')
      const results = repo.findManyBy('category', 'order-test', { orderBy: 'name ASC' })
      assert.ok(results.length >= 2)
      assert.equal(results[0].name, 'aaa-first')
    })

    test('limit option caps results', () => {
      insert('limit-1', 'limit-test')
      insert('limit-2', 'limit-test')
      insert('limit-3', 'limit-test')
      const results = repo.findManyBy('category', 'limit-test', { limit: 2 })
      assert.equal(results.length, 2)
    })
  })
}
