/**
 * Tests for MemoryRepository — CRUD, search, dedup, prompt injection, touch.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MemoryRepository (skipped — native module unavailable)', () => {
    test('create() inserts memory', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { memoryRepository } = require('../memory.repository')

  describe('MemoryRepository', () => {
    // ── create ──

    test('create() inserts and returns memory with all fields', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title: 'Use ESM imports',
        content: 'Always use ESM import syntax',
        tags: ['eslint', 'imports'],
        sourceConversationId: 'conv-1',
        sourceAgentId: 'agent-1',
        importance: 8
      })
      assert.ok(mem.id)
      assert.equal(mem.workspaceId, wsId)
      assert.equal(mem.type, 'convention')
      assert.equal(mem.title, 'Use ESM imports')
      assert.equal(mem.content, 'Always use ESM import syntax')
      assert.deepEqual(mem.tags, ['eslint', 'imports'])
      assert.equal(mem.sourceConversationId, 'conv-1')
      assert.equal(mem.sourceAgentId, 'agent-1')
      assert.equal(mem.importance, 8)
    })

    test('create() applies defaults for optional fields', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title: 'Defaults Test',
        content: 'Content'
      })
      assert.deepEqual(mem.tags, [])
      assert.equal(mem.sourceConversationId, null)
      assert.equal(mem.sourceAgentId, null)
      assert.equal(mem.importance, 5)
    })

    // ── findByWorkspace ──

    test('findByWorkspace() returns memories for workspace', () => {
      const memories = memoryRepository.findByWorkspace(wsId)
      assert.ok(memories.length >= 1)
      // Check they're ordered by importance DESC
      for (let i = 1; i < memories.length; i++) {
        if (memories[i - 1].importance === memories[i].importance) continue
        assert.ok(memories[i - 1].importance >= memories[i].importance)
      }
    })

    test('findByWorkspace() includes global memories (workspaceId=null)', () => {
      memoryRepository.create({
        workspaceId: null,
        type: 'convention',
        title: 'Global Rule',
        content: 'Applies everywhere'
      })
      const memories = memoryRepository.findByWorkspace(wsId)
      assert.ok(memories.some((m: any) => m.title === 'Global Rule'))
    })

    // ── findByType ──

    test('findByType() filters by memory type', () => {
      memoryRepository.create({
        workspaceId: wsId,
        type: 'gotcha',
        title: 'Gotcha Memory',
        content: 'Watch out for this'
      })
      const gotchas = memoryRepository.findByType(wsId, 'gotcha')
      assert.ok(gotchas.length >= 1)
      assert.ok(gotchas.every((m: any) => m.type === 'gotcha'))
    })

    // ── findById ──

    test('findById() returns memory', () => {
      const created = memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title: 'Find Test',
        content: 'Content'
      })
      const found = memoryRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'Find Test')
    })

    test('findById() returns undefined for unknown id', () => {
      const found = memoryRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    // ── search ──

    test('search() finds memories by title match', () => {
      memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title: 'UniqueSearchTitle999',
        content: 'some content'
      })
      const results = memoryRepository.search(wsId, 'UniqueSearchTitle999')
      assert.ok(results.length >= 1)
      assert.ok(results.some((m: any) => m.title === 'UniqueSearchTitle999'))
    })

    test('search() finds memories by content match', () => {
      memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title: 'Content Search',
        content: 'UniqueContentPhrase777'
      })
      const results = memoryRepository.search(wsId, 'UniqueContentPhrase777')
      assert.ok(results.length >= 1)
    })

    test('search() returns [] for no matches', () => {
      const results = memoryRepository.search(wsId, 'zzzzNeverMatchThiszzzzz')
      assert.deepEqual(results, [])
    })

    // ── update ──

    test('update() modifies title and content', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title: 'Old',
        content: 'Old content'
      })
      const updated = memoryRepository.update(mem.id, {
        title: 'New',
        content: 'New content',
        tags: ['updated'],
        importance: 9
      })
      assert.equal(updated.title, 'New')
      assert.equal(updated.content, 'New content')
      assert.deepEqual(updated.tags, ['updated'])
      assert.equal(updated.importance, 9)
    })

    test('update() preserves unmodified fields', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title: 'Partial Update',
        content: 'Keep this',
        importance: 7
      })
      const updated = memoryRepository.update(mem.id, { title: 'Changed' })
      assert.equal(updated.title, 'Changed')
      assert.equal(updated.content, 'Keep this')
      assert.equal(updated.importance, 7)
    })

    test('update() throws for unknown id', () => {
      assert.throws(() => memoryRepository.update('nonexistent', { title: 'X' }), {
        message: /not found/i
      })
    })

    // ── delete ──

    test('delete() removes memory', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title: 'To Delete',
        content: 'gone'
      })
      memoryRepository.delete(mem.id)
      const found = memoryRepository.findById(mem.id)
      assert.equal(found, undefined)
    })

    // ── touchMemories ──

    test('touchMemories() updates last_accessed_at', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title: 'Touch Test',
        content: 'content'
      })
      assert.equal(mem.lastAccessedAt, null)
      memoryRepository.touchMemories([mem.id])
      const touched = memoryRepository.findById(mem.id)
      assert.ok(touched)
      assert.ok(touched.lastAccessedAt)
    })

    test('touchMemories() handles empty array gracefully', () => {
      // Should not throw
      memoryRepository.touchMemories([])
    })

    // ── getForPrompt ──

    test('getForPrompt() returns memories within character budget', () => {
      // Create a memory with known size
      memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title: 'Prompt Mem',
        content: 'Short content',
        importance: 10
      })
      const mems = memoryRepository.getForPrompt(wsId, 10000)
      assert.ok(mems.length >= 1)
    })

    test('getForPrompt() respects budget limit', () => {
      // Very small budget should return few/no memories
      const mems = memoryRepository.getForPrompt(wsId, 10)
      // With a 10-char budget, most memories won't fit
      assert.ok(mems.length <= 1)
    })

    // ── countByWorkspace ──

    test('countByWorkspace() returns count', () => {
      const count = memoryRepository.countByWorkspace(wsId)
      assert.equal(typeof count, 'number')
      assert.ok(count >= 1)
    })

    // ── createIfNotDuplicate ──

    test('createIfNotDuplicate() creates when no duplicate exists', () => {
      const mem = memoryRepository.createIfNotDuplicate({
        workspaceId: wsId,
        type: 'insight',
        title: 'UniqueNoDup_' + Date.now(),
        content: 'content'
      })
      assert.ok(mem)
      assert.ok(mem.id)
    })

    test('createIfNotDuplicate() returns null when dominated duplicate exists', () => {
      const title = 'DupTest_' + Date.now()
      memoryRepository.create({
        workspaceId: wsId,
        type: 'insight',
        title,
        content: 'existing',
        importance: 8
      })
      const result = memoryRepository.createIfNotDuplicate({
        workspaceId: wsId,
        type: 'insight',
        title,
        content: 'new content',
        importance: 5 // lower importance → dominated
      })
      assert.equal(result, null)
    })

    // ── findSimilar ──

    test('findSimilar() finds memories with similar titles', () => {
      const title = 'SimilarTest_' + Date.now()
      memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title,
        content: 'content'
      })
      const similar = memoryRepository.findSimilar(wsId, title)
      assert.ok(similar.length >= 1)
    })

    test('findSimilar() excludes given id', () => {
      const title = 'ExcludeTest_' + Date.now()
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'convention',
        title,
        content: 'content'
      })
      const similar = memoryRepository.findSimilar(wsId, title, mem.id)
      assert.ok(!similar.some((m: any) => m.id === mem.id))
    })
  })
}
