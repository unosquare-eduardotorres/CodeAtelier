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
    filePath: 'src/auth/auth.service.ts',
    symbolName: 'validateJwt',
    symbolKind: 'method',
    body: 'validateJwt(token: string): boolean { return true }',
    startLine: 10,
    endLine: 15,
    signature: 'validateJwt(token: string): boolean',
    isPublic: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    language: 'typescript',
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
      indexedAt: Date.now(),
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
      [[1, 0, 0], [0, 0, 1], [0.7, 0.7, 0]],
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
      [[1, 0, 0], [0.9, 0.1, 0]],
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
    collection.upsert(['id-1', 'id-2'], [[1, 0, 0], [0, 1, 0]], [chunk, chunk])
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

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(`vector-search: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
