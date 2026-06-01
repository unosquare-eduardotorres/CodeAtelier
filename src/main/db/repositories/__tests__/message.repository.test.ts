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
      messageRepository.create(convId2, 'da-vinci', 'Second')
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

    // ── Tool Activities Persistence ──

    test('updateToolActivities() persists and mapRow() returns toolActivities', () => {
      const convId3 = seedConversation(db, wsId, 'ToolActivity Test')
      const msg = messageRepository.create(convId3, 'da-vinci', 'Response with tools')
      assert.equal(msg.toolActivities, undefined, 'should be undefined before update')

      const activities = [
        {
          id: 'tool-1',
          toolName: 'mcp__file-tools__Read',
          status: 'completed' as const,
          input: 'src/main/app.ts',
          result: '42 lines read',
          startedAt: 1000,
          completedAt: 2000,
          filePath: 'src/main/app.ts',
          operationType: 'read' as const
        },
        {
          id: 'tool-2',
          toolName: 'mcp__file-tools__Edit',
          status: 'completed' as const,
          input: 'src/main/app.ts',
          result: '1 replacement',
          startedAt: 3000,
          completedAt: 4000,
          filePath: 'src/main/app.ts',
          operationType: 'write' as const
        }
      ]

      messageRepository.updateToolActivities(msg.id, activities)

      const loaded = messageRepository.findById(msg.id)
      assert.ok(loaded)
      assert.ok(loaded.toolActivities, 'should have toolActivities after update')
      assert.equal(loaded.toolActivities!.length, 2)
      assert.equal(loaded.toolActivities![0].toolName, 'mcp__file-tools__Read')
      assert.equal(loaded.toolActivities![0].status, 'completed')
      assert.equal(loaded.toolActivities![0].filePath, 'src/main/app.ts')
      assert.equal(loaded.toolActivities![1].toolName, 'mcp__file-tools__Edit')
    })

    test('findByConversation() includes toolActivities', () => {
      const convId4 = seedConversation(db, wsId, 'ToolActivity List Test')
      const msg = messageRepository.create(convId4, 'da-vinci', 'Response')
      const activities = [
        { id: 'tool-3', toolName: 'Bash', status: 'completed' as const, startedAt: 5000, completedAt: 6000 }
      ]
      messageRepository.updateToolActivities(msg.id, activities)

      const messages = messageRepository.findByConversation(convId4)
      assert.equal(messages.length, 1)
      assert.ok(messages[0].toolActivities)
      assert.equal(messages[0].toolActivities![0].toolName, 'Bash')
    })

    test('updateToolActivities() is no-op for empty array', () => {
      const convId5 = seedConversation(db, wsId, 'Empty ToolActivity Test')
      const msg = messageRepository.create(convId5, 'da-vinci', 'No tools used')
      messageRepository.updateToolActivities(msg.id, [])

      const loaded = messageRepository.findById(msg.id)
      assert.ok(loaded)
      assert.equal(loaded.toolActivities, undefined, 'should remain undefined for empty array')
    })

    test('messages without tool_activities_json return undefined toolActivities', () => {
      const convId6 = seedConversation(db, wsId, 'No ToolActivity Test')
      const msg = messageRepository.create(convId6, 'user', 'Just text')
      assert.equal(msg.toolActivities, undefined)
    })
  })
}
