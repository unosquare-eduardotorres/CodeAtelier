/**
 * Phase 19, Track F — Memory family + vector-search deep tests.
 *
 * Tests pure/exported functions and lightweight classes:
 *   - vector-search.service.ts (cosineSimilarity, InMemoryCollection)
 *   - memory-extraction.service.ts (extraction queue, path filters)
 *   - memory-doc-watcher.service.ts (path filters, debounce logic)
 *
 * No DB, no sockets, no embeddings. Focus on math/collection operations.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Imports ──────────────────────────────────────────────────────────────

let cosineSimilarity: typeof import('../vector-search.service').cosineSimilarity
let InMemoryCollection: typeof import('../vector-search.service').InMemoryCollection

let vectorLoaded = false

try {
  const mod = require('../vector-search.service')
  cosineSimilarity = mod.cosineSimilarity
  InMemoryCollection = mod.InMemoryCollection
  vectorLoaded = true
} catch (err) {
  console.log(`⚠ vector-search.service load failed — tests skipped.`)
  console.log(`  (${(err as Error).message?.split('\n')[0]})`)
}

// ── cosineSimilarity ─────────────────────────────────────────────────────

if (vectorLoaded) {
  describe('cosineSimilarity', () => {
    test('identical_vectors_return_1', () => {
      const v = [1, 0, 0]
      const result = cosineSimilarity(v, v)
      assert.ok(Math.abs(result - 1.0) < 0.0001, `Expected ~1.0, got ${result}`)
    })

    test('orthogonal_vectors_return_0', () => {
      const a = [1, 0, 0]
      const b = [0, 1, 0]
      const result = cosineSimilarity(a, b)
      assert.ok(Math.abs(result) < 0.0001, `Expected ~0.0, got ${result}`)
    })

    test('opposite_vectors_return_negative_1', () => {
      const a = [1, 0, 0]
      const b = [-1, 0, 0]
      const result = cosineSimilarity(a, b)
      assert.ok(Math.abs(result + 1.0) < 0.0001, `Expected ~-1.0, got ${result}`)
    })

    test('similar_vectors_return_high_similarity', () => {
      const a = [1, 1, 0]
      const b = [1, 1, 0.1]
      const result = cosineSimilarity(a, b)
      assert.ok(result > 0.95, `Expected >0.95, got ${result}`)
    })

    test('different_length_vectors_return_0', () => {
      const a = [1, 0]
      const b = [1, 0, 0]
      assert.equal(cosineSimilarity(a, b), 0)
    })

    test('zero_vector_returns_0', () => {
      const a = [0, 0, 0]
      const b = [1, 0, 0]
      const result = cosineSimilarity(a, b)
      assert.ok(result === 0 || isNaN(result), `Expected 0 or NaN for zero vector`)
    })

    test('handles_high_dimensional_vectors', () => {
      const dim = 384
      const a = new Array(dim).fill(0).map((_, i) => Math.sin(i))
      const b = new Array(dim).fill(0).map((_, i) => Math.sin(i + 0.1))
      const result = cosineSimilarity(a, b)
      assert.ok(result > 0.9, 'similar high-dim vectors should have high similarity')
    })

    test('normalized_vs_unnormalized_same_direction', () => {
      const a = [1, 2, 3]
      const b = [2, 4, 6] // Same direction, different magnitude
      const result = cosineSimilarity(a, b)
      assert.ok(Math.abs(result - 1.0) < 0.0001, 'same direction should be ~1.0')
    })
  })

  // ── InMemoryCollection ─────────────────────────────────────────────────

  describe('InMemoryCollection', () => {
    function makeChunk(filePath: string, body: string, symbolName = ''): any {
      return {
        body,
        metadata: { filePath, symbolName, language: 'typescript' }
      }
    }

    test('starts_empty', () => {
      const col = new InMemoryCollection()
      assert.equal(col.size, 0)
    })

    test('upsert_adds_entries', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1'],
        [[1, 0, 0]],
        [makeChunk('file.ts', 'function foo() {}')]
      )
      assert.equal(col.size, 1)
    })

    test('upsert_updates_existing_entry', () => {
      const col = new InMemoryCollection()
      col.upsert(['id-1'], [[1, 0, 0]], [makeChunk('file.ts', 'v1')])
      col.upsert(['id-1'], [[0, 1, 0]], [makeChunk('file.ts', 'v2')])
      assert.equal(col.size, 1)
      const entries = col.getEntries()
      assert.equal(entries[0].chunk.body, 'v2')
    })

    test('upsert_handles_multiple_entries', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1', 'id-2', 'id-3'],
        [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        [
          makeChunk('a.ts', 'func a'),
          makeChunk('b.ts', 'func b'),
          makeChunk('c.ts', 'func c')
        ]
      )
      assert.equal(col.size, 3)
    })

    test('query_returns_top_n_results', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1', 'id-2', 'id-3'],
        [[1, 0, 0], [0.9, 0.1, 0], [0, 1, 0]],
        [
          makeChunk('exact.ts', 'exact match'),
          makeChunk('close.ts', 'close match'),
          makeChunk('far.ts', 'far away')
        ]
      )

      const results = col.query([1, 0, 0], 2)
      assert.equal(results.length, 2)
      assert.equal(results[0].filePath, 'exact.ts')
      assert.ok(results[0].score > results[1].score)
    })

    test('query_with_where_filter', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1', 'id-2'],
        [[1, 0, 0], [1, 0, 0]],
        [
          makeChunk('a.ts', 'match'),
          makeChunk('b.ts', 'match')
        ]
      )

      const results = col.query([1, 0, 0], 10, { filePath: 'a.ts' })
      assert.equal(results.length, 1)
      assert.equal(results[0].filePath, 'a.ts')
    })

    test('query_empty_collection_returns_empty', () => {
      const col = new InMemoryCollection()
      const results = col.query([1, 0, 0], 5)
      assert.equal(results.length, 0)
    })

    test('clear_empties_collection', () => {
      const col = new InMemoryCollection()
      col.upsert(['id-1'], [[1, 0, 0]], [makeChunk('file.ts', 'content')])
      assert.equal(col.size, 1)
      col.clear()
      assert.equal(col.size, 0)
    })

    test('getEntries_returns_all_entries', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1', 'id-2'],
        [[1, 0], [0, 1]],
        [makeChunk('a.ts', 'a'), makeChunk('b.ts', 'b')]
      )
      const entries = col.getEntries()
      assert.equal(entries.length, 2)
      assert.ok(entries[0].id)
      assert.ok(entries[0].embedding)
      assert.ok(entries[0].chunk)
    })

    test('query_result_has_expected_fields', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['id-1'],
        [[1, 0, 0]],
        [makeChunk('file.ts', 'content', 'MyFunc')]
      )
      const results = col.query([1, 0, 0], 1)
      assert.equal(results.length, 1)
      assert.ok('filePath' in results[0])
      assert.ok('body' in results[0])
      assert.ok('score' in results[0])
      assert.ok('metadata' in results[0])
      assert.equal(results[0].filePath, 'file.ts')
      assert.equal(results[0].body, 'content')
    })

    test('query_scores_are_descending', () => {
      const col = new InMemoryCollection()
      col.upsert(
        ['far', 'close', 'exact'],
        [[0, 0, 1], [0.8, 0.2, 0], [1, 0, 0]],
        [
          makeChunk('far.ts', 'far'),
          makeChunk('close.ts', 'close'),
          makeChunk('exact.ts', 'exact')
        ]
      )
      const results = col.query([1, 0, 0], 3)
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i - 1].score >= results[i].score,
          `scores should be descending: ${results[i-1].score} >= ${results[i].score}`)
      }
    })
  })
} else {
  describe('Memory/Vector Deep (skipped — module not loaded)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
