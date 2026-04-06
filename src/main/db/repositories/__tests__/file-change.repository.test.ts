/**
 * Tests for FileChangeRepository — track, upsert, clear, and find operations.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('FileChangeRepository (skipped — native module unavailable)', () => {
    test('track() inserts a file change', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const conversationId = seedConversation(db, wsId)

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { fileChangeRepository } = require('../file-change.repository')

  describe('FileChangeRepository', () => {
    test('track() inserts a file change', () => {
      fileChangeRepository.track(conversationId, 'src/index.ts', 'modified')
      const changes = fileChangeRepository.findByConversation(conversationId)
      assert.equal(changes.length, 1)
      assert.equal(changes[0].filePath, 'src/index.ts')
      assert.equal(changes[0].changeType, 'modified')
    })

    test('track() defaults changeType to modified', () => {
      const convId2 = seedConversation(db, wsId, 'Default Type')
      fileChangeRepository.track(convId2, 'src/app.ts')
      const changes = fileChangeRepository.findByConversation(convId2)
      assert.equal(changes[0].changeType, 'modified')
    })

    test('track() upserts on same (conversation, filePath)', () => {
      const convId3 = seedConversation(db, wsId, 'Upsert Test')
      fileChangeRepository.track(convId3, 'src/file.ts', 'created')
      fileChangeRepository.track(convId3, 'src/file.ts', 'modified')
      const changes = fileChangeRepository.findByConversation(convId3)
      assert.equal(changes.length, 1)
      assert.equal(changes[0].changeType, 'modified')
    })

    test('findByConversation() returns ordered by created_at', () => {
      const convId4 = seedConversation(db, wsId, 'Order Test')
      fileChangeRepository.track(convId4, 'a.ts', 'created')
      fileChangeRepository.track(convId4, 'b.ts', 'modified')
      fileChangeRepository.track(convId4, 'c.ts', 'deleted')
      const changes = fileChangeRepository.findByConversation(convId4)
      assert.equal(changes.length, 3)
      assert.equal(changes[0].filePath, 'a.ts')
      assert.equal(changes[2].filePath, 'c.ts')
    })

    test('findByConversation() returns empty array for unknown conversation', () => {
      const changes = fileChangeRepository.findByConversation('nonexistent')
      assert.deepEqual(changes, [])
    })

    test('clearByConversation() removes all entries', () => {
      const convId5 = seedConversation(db, wsId, 'Clear Test')
      fileChangeRepository.track(convId5, 'x.ts')
      fileChangeRepository.track(convId5, 'y.ts')
      assert.equal(fileChangeRepository.findByConversation(convId5).length, 2)

      fileChangeRepository.clearByConversation(convId5)
      assert.equal(fileChangeRepository.findByConversation(convId5).length, 0)
    })

    test('deleteByConversation() is an alias for clearByConversation()', () => {
      const convId6 = seedConversation(db, wsId, 'Delete Test')
      fileChangeRepository.track(convId6, 'z.ts')
      fileChangeRepository.deleteByConversation(convId6)
      assert.equal(fileChangeRepository.findByConversation(convId6).length, 0)
    })
  })
}
