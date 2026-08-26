/**
 * Tests for ConversationRepository — CRUD, archival, PR info, session management.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('ConversationRepository (skipped — native module unavailable)', () => {
    test('create() inserts with defaults', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env

  const { conversationRepository } = require('../conversation.repository')

  // Seed a second workspace for isolation tests
  const wsId2 = (() => {
    const row = db
      .prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
      .get('WS2', '/tmp/ws2') as { id: string }
    return row.id
  })()

  describe('ConversationRepository', () => {
    test('create() inserts with defaults', () => {
      const conv = conversationRepository.create(wsId)
      assert.equal(conv.workspaceId, wsId)
      assert.equal(conv.title, 'New Conversation')
      assert.equal(conv.mode, 'plan')
      assert.equal(conv.status, 'active')
      assert.ok(conv.id)
    })

    test('create() accepts custom title and mode', () => {
      const conv = conversationRepository.create(wsId, 'My Chat', 'build')
      assert.equal(conv.title, 'My Chat')
      assert.equal(conv.mode, 'build')
    })

    test('findByWorkspace() returns conversations for workspace', () => {
      conversationRepository.create(wsId2, 'First')
      conversationRepository.create(wsId2, 'Second')

      const convs = conversationRepository.findByWorkspace(wsId2)
      assert.equal(convs.length, 2)
      const titles = convs.map((c: any) => c.title).sort()
      assert.deepEqual(titles, ['First', 'Second'])
    })

    test('findById() returns a conversation', () => {
      const created = conversationRepository.create(wsId, 'Findable')
      const found = conversationRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = conversationRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('updateTitle() changes title', () => {
      const conv = conversationRepository.create(wsId, 'Old Title')
      const updated = conversationRepository.updateTitle(conv.id, 'New Title')
      assert.ok(updated)
      assert.equal(updated.title, 'New Title')
    })

    test('updateMode() switches mode', () => {
      const conv = conversationRepository.create(wsId, 'Mode Test')
      const updated = conversationRepository.updateMode(conv.id, 'build')
      assert.ok(updated)
      assert.equal(updated.mode, 'build')
    })

    test('archive() sets status to archived', () => {
      const conv = conversationRepository.create(wsId, 'To Archive')
      conversationRepository.archive(conv.id)
      const found = conversationRepository.findById(conv.id)
      assert.ok(found)
      assert.equal(found.status, 'archived')
    })

    test('updateSessionId() and getSessionId() round-trip', () => {
      const conv = conversationRepository.create(wsId, 'Session Test')
      assert.equal(conversationRepository.getSessionId(conv.id), undefined)

      conversationRepository.updateSessionId(conv.id, 'session-123')
      assert.equal(conversationRepository.getSessionId(conv.id), 'session-123')
    })

    test('updateHandoffContext() and getHandoffContext() round-trip', () => {
      const conv = conversationRepository.create(wsId, 'Handoff Test')
      assert.equal(conversationRepository.getHandoffContext(conv.id), null)

      conversationRepository.updateHandoffContext(conv.id, '[Handoff: blueprint → chat] continue')
      assert.equal(
        conversationRepository.getHandoffContext(conv.id),
        '[Handoff: blueprint → chat] continue'
      )
    })

    test('getHandoffContext() returns null for an unknown conversation', () => {
      assert.equal(conversationRepository.getHandoffContext('no-such-conversation'), null)
    })

    test('updatePrInfo() sets PR fields', () => {
      const conv = conversationRepository.create(wsId, 'PR Test')
      conversationRepository.updatePrInfo(conv.id, 'https://github.com/pr/1', 1, 'feat/branch')
      const found = conversationRepository.findById(conv.id)
      assert.ok(found)
      assert.equal(found.prUrl, 'https://github.com/pr/1')
      assert.equal(found.prNumber, 1)
      assert.equal(found.branchName, 'feat/branch')
    })

    test('delete() removes conversation', () => {
      const conv = conversationRepository.create(wsId, 'To Delete')
      conversationRepository.delete(conv.id)
      const found = conversationRepository.findById(conv.id)
      assert.equal(found, undefined)
    })

    // ── Orphan cleanup on delete ──

    test('delete() cleans up checkpoints for the conversation', () => {
      const conv = conversationRepository.create(wsId, 'Checkpoint Cleanup')
      // Insert a checkpoint row directly
      db.prepare(
        `INSERT INTO checkpoints (conversation_id, label, state_json) VALUES (?, ?, ?)`
      ).run(conv.id, 'test-checkpoint', '{}')

      const before = db
        .prepare('SELECT COUNT(*) as cnt FROM checkpoints WHERE conversation_id = ?')
        .get(conv.id) as { cnt: number }
      assert.equal(before.cnt, 1, 'checkpoint should exist before delete')

      conversationRepository.delete(conv.id)

      const after = db
        .prepare('SELECT COUNT(*) as cnt FROM checkpoints WHERE conversation_id = ?')
        .get(conv.id) as { cnt: number }
      assert.equal(after.cnt, 0, 'checkpoint should be cleaned up after delete')
    })

    test('delete() cleans up turn_usage for the conversation', () => {
      const conv = conversationRepository.create(wsId, 'TurnUsage Cleanup')
      // Insert a turn_usage row directly
      db.prepare(
        `INSERT INTO turn_usage (session_id, conversation_id, turn_number, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`
      ).run('session-1', conv.id, 1, 100, 50)

      const before = db
        .prepare('SELECT COUNT(*) as cnt FROM turn_usage WHERE conversation_id = ?')
        .get(conv.id) as { cnt: number }
      assert.equal(before.cnt, 1, 'turn_usage should exist before delete')

      conversationRepository.delete(conv.id)

      const after = db
        .prepare('SELECT COUNT(*) as cnt FROM turn_usage WHERE conversation_id = ?')
        .get(conv.id) as { cnt: number }
      assert.equal(after.cnt, 0, 'turn_usage should be cleaned up after delete')
    })

    test('delete() also removes messages for the conversation', () => {
      const conv = conversationRepository.create(wsId, 'Message Cleanup')
      const { messageRepository } = require('../message.repository')
      messageRepository.create(conv.id, 'user', 'Hello')
      messageRepository.create(conv.id, 'da-vinci', 'World')

      const beforeMsgs = messageRepository.findByConversation(conv.id)
      assert.equal(beforeMsgs.length, 2)

      conversationRepository.delete(conv.id)

      const afterMsgs = messageRepository.findByConversation(conv.id)
      assert.equal(afterMsgs.length, 0)
    })

    test("delete() does not affect other conversations' data", () => {
      const conv1 = conversationRepository.create(wsId, 'Keep This')
      const conv2 = conversationRepository.create(wsId, 'Delete This')

      db.prepare(
        `INSERT INTO checkpoints (conversation_id, label, state_json) VALUES (?, ?, ?)`
      ).run(conv1.id, 'keep-checkpoint', '{}')
      db.prepare(
        `INSERT INTO checkpoints (conversation_id, label, state_json) VALUES (?, ?, ?)`
      ).run(conv2.id, 'delete-checkpoint', '{}')

      conversationRepository.delete(conv2.id)

      const remaining = db
        .prepare('SELECT COUNT(*) as cnt FROM checkpoints WHERE conversation_id = ?')
        .get(conv1.id) as { cnt: number }
      assert.equal(remaining.cnt, 1, "other conversation's checkpoint should remain")
    })
  })
}
