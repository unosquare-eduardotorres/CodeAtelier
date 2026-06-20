/**
 * Tests for IdeaRepository — CRUD, status transitions, grill lifecycle.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('IdeaRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { ideaRepository } = require('../idea.repository')

  describe('IdeaRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const idea = ideaRepository.create(wsId, 'My Idea', 'A great idea')
      assert.ok(idea.id)
      assert.equal(idea.workspaceId, wsId)
      assert.equal(idea.title, 'My Idea')
      assert.equal(idea.description, 'A great idea')
      assert.equal(idea.status, 'draft')
      assert.equal(idea.grillConversationId, undefined)
      assert.equal(idea.grillSummary, undefined)
      assert.equal(idea.convertedConversationId, undefined)
    })

    test('findById() round-trip', () => {
      const created = ideaRepository.create(wsId, 'Findable', 'desc')
      const found = ideaRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findById() returns undefined for unknown', () => {
      const found = ideaRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('findByWorkspace() returns ideas newest first', () => {
      const wsId2 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Idea', '/tmp/idea') as { id: string }
        return row.id
      })()

      ideaRepository.create(wsId2, 'First', 'First idea')
      ideaRepository.create(wsId2, 'Second', 'Second idea')

      const ideas = ideaRepository.findByWorkspace(wsId2)
      assert.equal(ideas.length, 2)
      assert.equal(ideas[0].title, 'Second')
    })

    test('update() modifies title and description', () => {
      const idea = ideaRepository.create(wsId, 'Old Title', 'Old desc')
      const updated = ideaRepository.update(idea.id, {
        title: 'New Title', description: 'New desc'
      })
      assert.ok(updated)
      assert.equal(updated!.title, 'New Title')
      assert.equal(updated!.description, 'New desc')
    })

    test('update() with empty data returns existing', () => {
      const idea = ideaRepository.create(wsId, 'No Change', 'desc')
      const result = ideaRepository.update(idea.id, {})
      assert.ok(result)
      assert.equal(result!.title, 'No Change')
    })

    test('update() returns undefined for unknown id', () => {
      const result = ideaRepository.update('nonexistent', { title: 'X' })
      assert.equal(result, undefined)
    })

    test('updateStatus() changes status', () => {
      const idea = ideaRepository.create(wsId, 'Status Test', 'desc')
      const updated = ideaRepository.updateStatus(idea.id, 'grilling')
      assert.ok(updated)
      assert.equal(updated!.status, 'grilling')
    })

    test('setGrillConversation() links conversation', () => {
      const idea = ideaRepository.create(wsId, 'Grill Link', 'desc')
      const convId = seedConversation(db, wsId)
      const updated = ideaRepository.setGrillConversation(idea.id, convId)
      assert.ok(updated)
      assert.equal(updated!.grillConversationId, convId)
    })

    test('findByGrillConversation() finds by grill conversation', () => {
      const idea = ideaRepository.create(wsId, 'Grill Find', 'desc')
      const convId = seedConversation(db, wsId)
      ideaRepository.setGrillConversation(idea.id, convId)
      const found = ideaRepository.findByGrillConversation(convId)
      assert.ok(found)
      assert.equal(found.title, 'Grill Find')
    })

    test('setGrillSummary() stores summary', () => {
      const idea = ideaRepository.create(wsId, 'Summary Idea', 'desc')
      const updated = ideaRepository.setGrillSummary(idea.id, 'Grill went well')
      assert.ok(updated)
      assert.equal(updated!.grillSummary, 'Grill went well')
    })

    test('saveGrillDecisions() + clearGrillDecisions() lifecycle', () => {
      const idea = ideaRepository.create(wsId, 'Decisions', 'desc')
      ideaRepository.saveGrillDecisions(idea.id, '{"decisions": ["use React"]}')
      let found = ideaRepository.findById(idea.id)
      assert.equal(found!.grillDecisions, '{"decisions": ["use React"]}')

      ideaRepository.clearGrillDecisions(idea.id)
      found = ideaRepository.findById(idea.id)
      assert.equal(found!.grillDecisions, undefined)
    })

    test('setConvertedConversation() links converted conversation', () => {
      const idea = ideaRepository.create(wsId, 'Convert', 'desc')
      const convId = seedConversation(db, wsId)
      const updated = ideaRepository.setConvertedConversation(idea.id, convId)
      assert.ok(updated)
      assert.equal(updated!.convertedConversationId, convId)
    })

    test('delete() removes idea', () => {
      const idea = ideaRepository.create(wsId, 'Delete Me', 'desc')
      ideaRepository.delete(idea.id)
      assert.equal(ideaRepository.findById(idea.id), undefined)
    })
  })
}
