/**
 * Tests for CodeChunkRepository — upsertChunks, findByWorkspace/File, mtimes, counts.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CodeChunkRepository (skipped — native module unavailable)', () => {
    test('upsertChunks()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { codeChunkRepository } = require('../code-chunk.repository')

  const makeChunk = (id: string, filePath: string) => ({
    id,
    embedText: `function ${id}() { ... }`,
    body: `function ${id}() { return 42; }`,
    metadata: {
      filePath,
      fileName: filePath.split('/').pop()!,
      directory: filePath.split('/').slice(0, -1).join('/'),
      projectName: 'test',
      symbolName: id,
      symbolKind: 'function',
      className: null,
      signature: `${id}(): number`,
      startLine: 1,
      endLine: 3,
      language: 'typescript',
      isPublic: true,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      hasTests: false,
      importedBy: [],
      pageRank: 0,
      hasDocstring: false,
      lineCount: 3,
      hasDescription: false,
      lastModified: 0,
      indexedAt: Date.now()
    }
  })

  describe('CodeChunkRepository', () => {
    test('upsertChunks() inserts chunks', () => {
      const chunks = [
        makeChunk('chunk1', 'src/module-a.ts'),
        makeChunk('chunk2', 'src/module-a.ts'),
        makeChunk('chunk3', 'src/module-b.ts')
      ]
      const mtimes = new Map([
        ['src/module-a.ts', 1000],
        ['src/module-b.ts', 2000]
      ])
      codeChunkRepository.upsertChunks(wsId, chunks, mtimes)

      const all = codeChunkRepository.findByWorkspace(wsId)
      assert.ok(all.length >= 3)
    })

    test('mapRowToChunk() reconstructs ProcessedChunk with nested metadata', () => {
      const chunks = codeChunkRepository.findByWorkspace(wsId)
      const chunk = chunks.find((c: any) => c.id === 'chunk1')
      assert.ok(chunk)
      assert.equal(chunk.id, 'chunk1')
      assert.ok(chunk.embedText.includes('chunk1'))
      assert.ok(chunk.body.includes('return 42'))
      assert.equal(chunk.metadata.filePath, 'src/module-a.ts')
      assert.equal(chunk.metadata.symbolName, 'chunk1')
      assert.equal(chunk.metadata.symbolKind, 'function')
      assert.equal(chunk.metadata.isPublic, true)
      assert.equal(chunk.metadata.isAsync, false)
      assert.equal(chunk.metadata.lineCount, 3)
    })

    test('findByFile() returns chunks for a specific file', () => {
      const chunks = codeChunkRepository.findByFile(wsId, 'src/module-a.ts')
      assert.equal(chunks.length, 2)
      assert.ok(chunks.every((c: any) => c.metadata.filePath === 'src/module-a.ts'))
    })

    test('getFileMtimes() returns mtime map', () => {
      const mtimes = codeChunkRepository.getFileMtimes(wsId)
      assert.ok(mtimes instanceof Map)
      assert.equal(mtimes.get('src/module-a.ts'), 1000)
      assert.equal(mtimes.get('src/module-b.ts'), 2000)
    })

    test('countByWorkspace() returns correct count', () => {
      const count = codeChunkRepository.countByWorkspace(wsId)
      assert.ok(count >= 3)
    })

    test('deleteByFile() removes chunks for one file', () => {
      const deleted = codeChunkRepository.deleteByFile(wsId, 'src/module-b.ts')
      assert.ok(deleted >= 1)
      const remaining = codeChunkRepository.findByFile(wsId, 'src/module-b.ts')
      assert.equal(remaining.length, 0)
    })

    test('upsertChunks() replaces existing chunks (INSERT OR REPLACE)', () => {
      const updated = [makeChunk('chunk1', 'src/module-a.ts')]
      updated[0].body = 'function chunk1() { return 99; }'
      codeChunkRepository.upsertChunks(wsId, updated, new Map([['src/module-a.ts', 3000]]))

      const chunk = codeChunkRepository
        .findByFile(wsId, 'src/module-a.ts')
        .find((c: any) => c.id === 'chunk1')
      assert.ok(chunk)
      assert.ok(chunk.body.includes('return 99'))
    })

    test('deleteByWorkspace() clears all chunks', () => {
      const deleted = codeChunkRepository.deleteByWorkspace(wsId)
      assert.ok(deleted >= 0)
      assert.equal(codeChunkRepository.countByWorkspace(wsId), 0)
    })
  })
}
