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

    test('findByWorkspace() returns conversations sorted by created_at DESC', () => {
      conversationRepository.create(wsId2, 'First')
      conversationRepository.create(wsId2, 'Second')

      const convs = conversationRepository.findByWorkspace(wsId2)
      assert.equal(convs.length, 2)
      assert.equal(convs[0].title, 'Second')
      assert.equal(convs[1].title, 'First')
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
  })
}
