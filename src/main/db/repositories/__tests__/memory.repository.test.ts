/**
 * Tests for MemoryRepository — CRUD, search, dedup, prompt injection, touch.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MemoryRepository (skipped — native module unavailable)', () => {
    test('create()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { memoryRepository } = require('../memory.repository')

  describe('MemoryRepository', () => {
    test('create() returns mapped model with defaults', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'learned',
        title: 'Test Memory',
        content: 'Some content'
      })
      assert.ok(mem.id)
      assert.equal(mem.workspaceId, wsId)
      assert.equal(mem.type, 'learned')
      assert.equal(mem.title, 'Test Memory')
      assert.equal(mem.content, 'Some content')
      assert.deepEqual(mem.tags, [])
      assert.equal(mem.importance, 5)
    })

    test('create() accepts tags and custom importance', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId,
        type: 'pinned',
        title: 'Tagged',
        content: 'Has tags',
        tags: ['architecture', 'testing'],
        importance: 9
      })
      assert.deepEqual(mem.tags, ['architecture', 'testing'])
      assert.equal(mem.importance, 9)
    })

    test('findById() round-trip', () => {
      const created = memoryRepository.create({
        workspaceId: wsId, type: 'learned', title: 'Findable', content: 'X'
      })
      const found = memoryRepository.findById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findById() returns undefined for unknown', () => {
      const found = memoryRepository.findById('nonexistent')
      assert.equal(found, undefined)
    })

    test('findByWorkspace() returns all workspace memories', () => {
      const mems = memoryRepository.findByWorkspace(wsId)
      assert.ok(mems.length > 0)
    })

    test('findByType() filters by type', () => {
      const pinned = memoryRepository.findByType(wsId, 'pinned')
      assert.ok(pinned.every((m: any) => m.type === 'pinned'))
    })

    test('search() finds by title substring', () => {
      memoryRepository.create({
        workspaceId: wsId, type: 'learned',
        title: 'UniqueSearchableMemory', content: 'body'
      })
      const results = memoryRepository.search(wsId, 'UniqueSearchable')
      assert.ok(results.some((m: any) => m.title === 'UniqueSearchableMemory'))
    })

    test('search() finds by content substring', () => {
      memoryRepository.create({
        workspaceId: wsId, type: 'learned',
        title: 'ContentSearch', content: 'xyz_unique_content_marker'
      })
      const results = memoryRepository.search(wsId, 'xyz_unique_content_marker')
      assert.ok(results.length >= 1)
    })

    test('update() modifies fields', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId, type: 'learned', title: 'Old', content: 'Old content'
      })
      const updated = memoryRepository.update(mem.id, {
        title: 'New',
        content: 'New content',
        tags: ['updated'],
        importance: 8
      })
      assert.equal(updated.title, 'New')
      assert.equal(updated.content, 'New content')
      assert.deepEqual(updated.tags, ['updated'])
      assert.equal(updated.importance, 8)
    })

    test('update() throws for nonexistent id', () => {
      assert.throws(() => memoryRepository.update('nonexistent', { title: 'X' }), /not found/i)
    })

    test('delete() removes memory', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId, type: 'learned', title: 'Delete Me', content: ''
      })
      memoryRepository.delete(mem.id)
      const found = memoryRepository.findById(mem.id)
      assert.equal(found, undefined)
    })

    test('touchMemories() updates last_accessed_at', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId, type: 'learned', title: 'Touch', content: ''
      })
      assert.equal(mem.lastAccessedAt, null)
      memoryRepository.touchMemories([mem.id])
      const touched = memoryRepository.findById(mem.id)
      assert.ok(touched!.lastAccessedAt)
    })

    test('touchMemories() handles empty array gracefully', () => {
      // Should not throw
      memoryRepository.touchMemories([])
    })

    test('getForPrompt() respects character budget', () => {
      // Create several memories with known sizes
      for (let i = 0; i < 5; i++) {
        memoryRepository.create({
          workspaceId: wsId, type: 'learned',
          title: `Prompt Mem ${i}`, content: 'A'.repeat(100),
          importance: 10 - i
        })
      }
      const limited = memoryRepository.getForPrompt(wsId, 200)
      // Should stop before exceeding budget
      const totalChars = limited.reduce((sum: number, m: any) => sum + m.title.length + m.content.length + 20, 0)
      assert.ok(totalChars <= 200 + 150) // rough tolerance
    })

    test('countByWorkspace() returns count', () => {
      const count = memoryRepository.countByWorkspace(wsId)
      assert.ok(count > 0)
    })

    test('createIfNotDuplicate() skips when dominated', () => {
      memoryRepository.create({
        workspaceId: wsId, type: 'learned',
        title: 'DupTarget', content: 'Original', importance: 8
      })
      const result = memoryRepository.createIfNotDuplicate({
        workspaceId: wsId, type: 'learned',
        title: 'DupTarget', content: 'Duplicate', importance: 5
      })
      assert.equal(result, null)
    })

    test('createIfNotDuplicate() creates when not dominated', () => {
      const result = memoryRepository.createIfNotDuplicate({
        workspaceId: wsId, type: 'learned',
        title: 'DupTarget', content: 'Higher importance', importance: 10
      })
      assert.ok(result)
      assert.equal(result.importance, 10)
    })

    test('findSimilar() finds matching titles', () => {
      const similar = memoryRepository.findSimilar(wsId, 'DupTarget')
      assert.ok(similar.length >= 2)
    })

    test('findSimilar() respects excludeId', () => {
      const mem = memoryRepository.create({
        workspaceId: wsId, type: 'learned',
        title: 'ExcludeTest', content: ''
      })
      const withExclude = memoryRepository.findSimilar(wsId, 'ExcludeTest', mem.id)
      assert.ok(withExclude.every((m: any) => m.id !== mem.id))
    })
  })
}
