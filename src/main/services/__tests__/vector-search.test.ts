/**
 * Unit tests for vector-search.service.ts pure functions and InMemoryCollection.
 * Tests cosine similarity, upsert, query with filtering, and collection lifecycle.
 */
import assert from 'node:assert/strict'
import { cosineSimilarity, InMemoryCollection } from '../vector-search.service'
import type { ProcessedChunk } from '../preprocessing.service'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  \u2713 ${name}`)
    passed++
  } catch (err) {
    console.error(`  \u2717 ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

/** Helper to create a minimal ProcessedChunk for testing */
function makeProcessedChunk(overrides: Partial<ProcessedChunk['metadata']> = {}): ProcessedChunk {
  return {
    id: `chunk-${Math.random().toString(36).slice(2, 8)}`,
    body: 'validateJwt(token: string): boolean { return true }',
    embedText: '# File: auth.service.ts\nvalidateJwt(token: string): boolean { return true }',
    metadata: {
      filePath: 'src/auth/auth.service.ts',
      fileName: 'auth.service.ts',
      directory: 'src/auth',
      symbolName: 'validateJwt',
      symbolKind: 'method',
      className: 'AuthService',
      signature: 'validateJwt(token: string): boolean',
      startLine: 10,
      endLine: 15,
      language: 'typescript',
      isPublic: true,
      isAsync: false,
      isStatic: false,
      isAbstract: false,
      hasDocstring: false,
      lineCount: 5,
      hasDescription: false,
      lastModified: 0,
      indexedAt: Date.now(),
      projectName: '',
      hasTests: false,
      importedBy: [],
      pageRank: 0,
      ...overrides
    }
  }
}

// ── cosineSimilarity ──

describe('cosineSimilarity', () => {
  test('identical vectors return 1.0', () => {
    const v = [1, 2, 3]
    const result = cosineSimilarity(v, v)
    assert.ok(Math.abs(result - 1.0) < 1e-10, `Expected ~1.0, got ${result}`)
  })

  test('orthogonal vectors return 0.0', () => {
    const a = [1, 0, 0]
    const b = [0, 1, 0]
    const result = cosineSimilarity(a, b)
    assert.ok(Math.abs(result) < 1e-10, `Expected ~0.0, got ${result}`)
  })

  test('opposite vectors return -1.0', () => {
    const a = [1, 0, 0]
    const b = [-1, 0, 0]
    const result = cosineSimilarity(a, b)
    assert.ok(Math.abs(result - -1.0) < 1e-10, `Expected ~-1.0, got ${result}`)
  })

  test('different lengths return 0.0', () => {
    const a = [1, 2, 3]
    const b = [1, 2]
    const result = cosineSimilarity(a, b)
    assert.equal(result, 0, 'Mismatched lengths should return 0')
  })

  test('zero vectors return 0.0', () => {
    const a = [0, 0, 0]
    const b = [1, 2, 3]
    const result = cosineSimilarity(a, b)
    assert.equal(result, 0, 'Zero vector should return 0')
  })
})

// ── InMemoryCollection ──

describe('InMemoryCollection.upsert', () => {
  test('adds entries', () => {
    const collection = new InMemoryCollection()
    const chunk = makeProcessedChunk()
    collection.upsert(['id-1'], [[1, 0, 0]], [chunk])
    assert.equal(collection.size, 1)
  })

  test('updates existing entry by id', () => {
    const collection = new InMemoryCollection()
    const chunk1 = makeProcessedChunk({ symbolName: 'original' })
    const chunk2 = makeProcessedChunk({ symbolName: 'updated' })

    collection.upsert(['id-1'], [[1, 0, 0]], [chunk1])
    assert.equal(collection.size, 1)

    collection.upsert(['id-1'], [[0, 1, 0]], [chunk2])
    assert.equal(collection.size, 1, 'Should still be 1 entry after upsert')

    // Query with the updated embedding to verify it was replaced
    const results = collection.query([0, 1, 0], 1)
    assert.equal(results[0].symbolName, 'updated')
  })
})

describe('InMemoryCollection.query', () => {
  test('returns top N by similarity', () => {
    const collection = new InMemoryCollection()

    const chunkA = makeProcessedChunk({ symbolName: 'close' })
    const chunkB = makeProcessedChunk({ symbolName: 'far' })
    const chunkC = makeProcessedChunk({ symbolName: 'medium' })

    // Query vector is [1, 0, 0]
    // chunkA embedding [1, 0, 0] — identical (similarity ~1.0)
    // chunkC embedding [0.7, 0.7, 0] — medium similarity
    // chunkB embedding [0, 0, 1] — orthogonal (similarity ~0.0)
    collection.upsert(
      ['a', 'b', 'c'],
      [
        [1, 0, 0],
        [0, 0, 1],
        [0.7, 0.7, 0]
      ],
      [chunkA, chunkB, chunkC]
    )

    const results = collection.query([1, 0, 0], 2)
    assert.equal(results.length, 2)
    assert.equal(results[0].symbolName, 'close', 'Most similar should be first')
    assert.equal(results[1].symbolName, 'medium', 'Second most similar should be second')
  })

  test('filters by metadata where clause', () => {
    const collection = new InMemoryCollection()

    const tsChunk = makeProcessedChunk({ language: 'typescript', symbolName: 'tsFunc' })
    const pyChunk = makeProcessedChunk({ language: 'python', symbolName: 'pyFunc' })

    collection.upsert(
      ['ts-1', 'py-1'],
      [
        [1, 0, 0],
        [0.9, 0.1, 0]
      ],
      [tsChunk, pyChunk]
    )

    const results = collection.query([1, 0, 0], 10, { language: 'python' })
    assert.equal(results.length, 1)
    assert.equal(results[0].symbolName, 'pyFunc')
  })

  test('returns empty array when no entries match filter', () => {
    const collection = new InMemoryCollection()

    const chunk = makeProcessedChunk({ language: 'typescript' })
    collection.upsert(['id-1'], [[1, 0, 0]], [chunk])

    const results = collection.query([1, 0, 0], 10, { language: 'rust' })
    assert.equal(results.length, 0)
  })
})

describe('InMemoryCollection.clear', () => {
  test('resets size to 0', () => {
    const collection = new InMemoryCollection()
    const chunk = makeProcessedChunk()
    collection.upsert(
      ['id-1', 'id-2'],
      [
        [1, 0, 0],
        [0, 1, 0]
      ],
      [chunk, chunk]
    )
    assert.equal(collection.size, 2)

    collection.clear()
    assert.equal(collection.size, 0)
  })
})

describe('InMemoryCollection.size', () => {
  test('tracks entry count correctly', () => {
    const collection = new InMemoryCollection()
    assert.equal(collection.size, 0)

    const chunk = makeProcessedChunk()
    collection.upsert(['a'], [[1, 0, 0]], [chunk])
    assert.equal(collection.size, 1)

    collection.upsert(['b'], [[0, 1, 0]], [chunk])
    assert.equal(collection.size, 2)

    collection.upsert(['c'], [[0, 0, 1]], [chunk])
    assert.equal(collection.size, 3)
  })
})

// ── Search edge cases ──

describe('InMemoryCollection.query edge cases', () => {
  test('empty collection returns empty results', () => {
    const collection = new InMemoryCollection()
    const results = collection.query([1, 0, 0], 10)
    assert.equal(results.length, 0)
  })

  test('caps nResults to available entries', () => {
    const collection = new InMemoryCollection()
    const chunk = makeProcessedChunk()
    collection.upsert(['only-one'], [[1, 0, 0]], [chunk])

    // Ask for 100 results but only 1 exists
    const results = collection.query([1, 0, 0], 100)
    assert.equal(results.length, 1)
  })

  test('nResults=0 returns empty array', () => {
    const collection = new InMemoryCollection()
    const chunk = makeProcessedChunk()
    collection.upsert(['id-1'], [[1, 0, 0]], [chunk])

    const results = collection.query([1, 0, 0], 0)
    assert.equal(results.length, 0)
  })

  test('query with all-zero embedding returns results (sorted by default)', () => {
    const collection = new InMemoryCollection()
    const chunk = makeProcessedChunk()
    collection.upsert(['id-1'], [[1, 0, 0]], [chunk])

    // Zero query vector → cosine similarity = 0 for all entries, but should not throw
    const results = collection.query([0, 0, 0], 10)
    assert.equal(results.length, 1)
  })

  test('getEntries returns all stored entries', () => {
    const collection = new InMemoryCollection()
    const chunkA = makeProcessedChunk({ symbolName: 'first' })
    const chunkB = makeProcessedChunk({ symbolName: 'second' })
    collection.upsert(
      ['a', 'b'],
      [
        [1, 0, 0],
        [0, 1, 0]
      ],
      [chunkA, chunkB]
    )

    const entries = collection.getEntries()
    assert.equal(entries.length, 2)
  })
})

// ── Indexing pipeline structural verification ──
// These tests verify critical structural invariants of the indexing pipeline
// by reading the source code, ensuring guards and phases remain in the correct order.

import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('VectorSearchService.indexProject — phase transitions', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/main/services/vector-search.service.ts'),
    'utf-8'
  )

  test('EMBEDDING_BATCH_SIZE constant is 32', () => {
    assert.ok(
      source.includes('EMBEDDING_BATCH_SIZE = 32'),
      'Batch size should be 32 for WASM backend (adaptive retry halves on OOM)'
    )
  })

  test('embedding init is deferred until after preprocessing (not before)', () => {
    // The WASM model init must come AFTER preprocessing (which spawns CLI processes)
    // to avoid memory pressure from concurrent CLI + WASM allocation.
    // After decomposition, embedding init is in embedChunksWithCheckpoints.
    const preprocessIdx = source.indexOf('preprocessChunks')
    const initIdx = source.indexOf('Embedding model init')
    const batchLoopIdx = source.indexOf('for (let i = startOffset; i < processedChunks.length')
    assert.ok(preprocessIdx > 0, 'preprocessChunks method should exist')
    assert.ok(initIdx > 0, 'Deferred embedding init comment should exist')
    assert.ok(batchLoopIdx > 0, 'Batch loop should exist')
    assert.ok(initIdx > preprocessIdx, 'Embedding init should come after preprocessing')
    assert.ok(initIdx < batchLoopIdx, 'Embedding init should come before batch loop')
  })

  test('GC hint exists between preprocessing and embedding batch loop', () => {
    const preprocessEndIdx = source.indexOf('preprocessOpts.cancelled')
    const gcIdx = source.indexOf('global.gc()')
    const batchLoopIdx = source.indexOf('for (let i = 0; i < processedChunks.length')
    assert.ok(gcIdx > 0, 'GC hint should exist')
    assert.ok(batchLoopIdx > 0, 'Batch loop should exist')
    assert.ok(preprocessEndIdx > 0, 'Preprocessing cancellation check should exist')
    // GC comes after preprocessing cancellation check, before the batch embed loop
    assert.ok(gcIdx > preprocessEndIdx, 'GC hint should come after preprocessing')
    assert.ok(gcIdx < batchLoopIdx, 'GC hint should come before batch embed loop')
  })
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`vector-search: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
