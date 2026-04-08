/**
 * Tests for MessageRepository — CRUD operations on messages table.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MessageRepository (skipped — native module unavailable)', () => {
    test('create() inserts and returns a mapped message', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const conversationId = seedConversation(db, wsId)

  // Import AFTER db injection so the repository uses our in-memory DB

  const { messageRepository } = require('../message.repository')

  describe('MessageRepository', () => {
    test('create() inserts and returns a mapped message', () => {
      const msg = messageRepository.create(conversationId, 'user', 'Hello world')
      assert.equal(msg.conversationId, conversationId)
      assert.equal(msg.role, 'user')
      assert.equal(msg.contentMd, 'Hello world')
      assert.ok(msg.id, 'should have an id')
      assert.ok(msg.createdAt, 'should have createdAt')
    })

    test('create() stores agentId when provided', () => {
      const msg = messageRepository.create(
        conversationId,
        'specialist',
        'Agent response',
        'frontend-architect'
      )
      assert.equal(msg.agentId, 'frontend-architect')
    })

    test('create() defaults attachmentsJson to empty array', () => {
      const msg = messageRepository.create(conversationId, 'user', 'No attachments')
      assert.equal(msg.attachmentsJson, '[]')
    })

    test('findByConversation() returns messages in chronological order', () => {
      const convId2 = seedConversation(db, wsId, 'Conv 2')
      messageRepository.create(convId2, 'user', 'First')
      messageRepository.create(convId2, 'coordinator', 'Second')
      messageRepository.create(convId2, 'specialist', 'Third')

      const messages = messageRepository.findByConversation(convId2)
      assert.equal(messages.length, 3)
      assert.equal(messages[0].contentMd, 'First')
      assert.equal(messages[1].contentMd, 'Second')
      assert.equal(messages[2].contentMd, 'Third')
    })

    test('findByConversation() returns empty array for unknown conversation', () => {
      const messages = messageRepository.findByConversation('nonexistent-id')
      assert.deepEqual(messages, [])
    })

    test('findById() returns a single message', () => {
      const created = messageRepository.create(conversationId, 'user', 'Find me')
      const found = messageRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.contentMd, 'Find me')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = messageRepository.findById('nonexistent-id')
      assert.equal(found, undefined)
    })
  })
}
