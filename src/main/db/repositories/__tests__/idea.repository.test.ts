/**
 * Tests for IdeaRepository — CRUD, status, grill integration, decisions.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedConversation } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('IdeaRepository (skipped — native module unavailable)', () => {
    test('create() inserts idea', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { ideaRepository } = require('../idea.repository')

  describe('IdeaRepository', () => {
    // ── create ──

    test('create() inserts and returns idea', () => {
      const idea = ideaRepository.create(wsId, 'My Idea', 'A great idea')
      assert.ok(idea.id)
      assert.equal(idea.workspaceId, wsId)
      assert.equal(idea.title, 'My Idea')
      assert.equal(idea.description, 'A great idea')
      assert.equal(idea.status, 'draft')
      assert.equal(idea.grillConversationId, undefined)
      assert.ok(idea.createdAt)
    })

    // ── findByWorkspace ──

    test('findByWorkspace() returns ideas for workspace', () => {
      const freshWsId = 'idea-ws-test'
      env.db
        .prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`)
        .run(freshWsId, 'Ideas WS', '/tmp/ideas-ws')

      ideaRepository.create(freshWsId, 'First', 'desc1')
      ideaRepository.create(freshWsId, 'Second', 'desc2')

      const ideas = ideaRepository.findByWorkspace(freshWsId)
      assert.equal(ideas.length, 2)
      const titles = ideas.map((i: any) => i.title).sort()
      assert.deepEqual(titles, ['First', 'Second'])
    })

    test('findByWorkspace() returns [] for empty workspace', () => {
      const ideas = ideaRepository.findByWorkspace('nonexistent-ws')
      assert.deepEqual(ideas, [])
    })

    // ── findById ──

    test('findById() returns idea', () => {
      const created = ideaRepository.create(wsId, 'Findable Idea', 'desc')
      const found = ideaRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable Idea')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = ideaRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    // ── update ──

    test('update() modifies title and description', () => {
      const idea = ideaRepository.create(wsId, 'Old Title', 'Old desc')
      const updated = ideaRepository.update(idea.id, {
        title: 'New Title',
        description: 'New desc'
      })
      assert.ok(updated)
      assert.equal(updated.title, 'New Title')
      assert.equal(updated.description, 'New desc')
    })

    test('update() modifies only title', () => {
      const idea = ideaRepository.create(wsId, 'Title Only', 'Keep this desc')
      const updated = ideaRepository.update(idea.id, { title: 'Updated Title' })
      assert.ok(updated)
      assert.equal(updated.title, 'Updated Title')
      assert.equal(updated.description, 'Keep this desc')
    })

    test('update() with no changes returns existing idea', () => {
      const idea = ideaRepository.create(wsId, 'No Change', 'desc')
      const result = ideaRepository.update(idea.id, {})
      assert.ok(result)
      assert.equal(result.title, 'No Change')
    })

    test('update() returns undefined for unknown id', () => {
      const result = ideaRepository.update('nonexistent', { title: 'X' })
      assert.equal(result, undefined)
    })

    // ── updateStatus ──

    test('updateStatus() transitions status', () => {
      const idea = ideaRepository.create(wsId, 'Status Test', 'desc')
      assert.equal(idea.status, 'draft')

      const grilling = ideaRepository.updateStatus(idea.id, 'grilling')
      assert.ok(grilling)
      assert.equal(grilling.status, 'grilling')

      const completed = ideaRepository.updateStatus(idea.id, 'completed')
      assert.ok(completed)
      assert.equal(completed.status, 'completed')
    })

    // ── setGrillConversation ──

    test('setGrillConversation() links idea to conversation', () => {
      const idea = ideaRepository.create(wsId, 'Grill Link', 'desc')
      const convId = seedConversation(env.db, wsId, 'Grill Conv')
      const updated = ideaRepository.setGrillConversation(idea.id, convId)
      assert.ok(updated)
      assert.equal(updated.grillConversationId, convId)
    })

    // ── findByGrillConversation ──

    test('findByGrillConversation() returns idea by conversation id', () => {
      const idea = ideaRepository.create(wsId, 'Conv Lookup', 'desc')
      const convId = seedConversation(env.db, wsId, 'Lookup Conv')
      ideaRepository.setGrillConversation(idea.id, convId)
      const found = ideaRepository.findByGrillConversation(convId)
      assert.ok(found)
      assert.equal(found.title, 'Conv Lookup')
    })

    test('findByGrillConversation() returns undefined for unknown conversation', () => {
      const found = ideaRepository.findByGrillConversation('no-such-conv')
      assert.equal(found, undefined)
    })

    // ── setGrillSummary ──

    test('setGrillSummary() stores summary', () => {
      const idea = ideaRepository.create(wsId, 'Summary Test', 'desc')
      const updated = ideaRepository.setGrillSummary(idea.id, 'The grill went well')
      assert.ok(updated)
      assert.equal(updated.grillSummary, 'The grill went well')
    })

    // ── setConvertedConversation ──

    test('setConvertedConversation() stores converted conversation id', () => {
      const idea = ideaRepository.create(wsId, 'Convert Test', 'desc')
      const convId = seedConversation(env.db, wsId, 'Converted Conv')
      const updated = ideaRepository.setConvertedConversation(idea.id, convId)
      assert.ok(updated)
      assert.equal(updated.convertedConversationId, convId)
    })

    // ── saveGrillDecisions / clearGrillDecisions ──

    test('saveGrillDecisions() stores decisions JSON', () => {
      const idea = ideaRepository.create(wsId, 'Decisions Test', 'desc')
      const updated = ideaRepository.saveGrillDecisions(idea.id, '{"key":"value"}')
      assert.ok(updated)
      assert.equal(updated.grillDecisions, '{"key":"value"}')
    })

    test('clearGrillDecisions() removes decisions', () => {
      const idea = ideaRepository.create(wsId, 'Clear Decisions', 'desc')
      ideaRepository.saveGrillDecisions(idea.id, '{"data":true}')
      const cleared = ideaRepository.clearGrillDecisions(idea.id)
      assert.ok(cleared)
      assert.equal(cleared.grillDecisions, undefined)
    })

    // ── delete ──

    test('delete() removes idea', () => {
      const idea = ideaRepository.create(wsId, 'To Delete', 'desc')
      ideaRepository.delete(idea.id)
      const found = ideaRepository.findById(idea.id)
      assert.equal(found, undefined)
    })
  })
}
