/**
 * Tests for vector-search.service.ts pure functions — cosineSimilarity
 * and the chunk-embedding serialization helpers.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// cosineSimilarity is exported from vector-search.service.ts
import { cosineSimilarity } from '../vector-search.service'

// Embedding serialization is in the repository but tests pure math
import {
  serializeEmbedding,
  deserializeEmbedding
} from '../../db/repositories/chunk-embedding.repository'

describe('cosineSimilarity', () => {
  test('identical vectors have similarity 1.0', () => {
    const result = cosineSimilarity([1, 0, 0], [1, 0, 0])
    assert.ok(Math.abs(result - 1.0) < 0.0001)
  })

  test('orthogonal vectors have similarity 0.0', () => {
    const result = cosineSimilarity([1, 0, 0], [0, 1, 0])
    assert.ok(Math.abs(result) < 0.0001)
  })

  test('opposite vectors have similarity -1.0', () => {
    const result = cosineSimilarity([1, 0], [-1, 0])
    assert.ok(Math.abs(result - -1.0) < 0.0001)
  })

  test('similar vectors have high similarity', () => {
    const result = cosineSimilarity([1, 1, 0], [1, 0.9, 0.1])
    assert.ok(result > 0.9)
  })

  test('handles zero vector gracefully', () => {
    const result = cosineSimilarity([0, 0, 0], [1, 1, 1])
    // Should return 0 or NaN — not crash
    assert.equal(typeof result, 'number')
  })

  test('works with larger vectors', () => {
    const a = Array.from({ length: 384 }, (_, i) => Math.sin(i))
    const b = Array.from({ length: 384 }, (_, i) => Math.sin(i + 0.1))
    const result = cosineSimilarity(a, b)
    assert.ok(result > 0.99, 'Very similar vectors should have high similarity')
  })

  test('is symmetric', () => {
    const a = [0.5, 0.3, 0.8]
    const b = [0.2, 0.7, 0.1]
    const ab = cosineSimilarity(a, b)
    const ba = cosineSimilarity(b, a)
    assert.ok(Math.abs(ab - ba) < 0.0001)
  })

  test('normalized vectors produce same result', () => {
    const a = [3, 4] // magnitude 5
    const b = [0.6, 0.8] // normalized a
    const c = [1, 0] // unit vector
    const r1 = cosineSimilarity(a, c)
    const r2 = cosineSimilarity(b, c)
    assert.ok(Math.abs(r1 - r2) < 0.0001)
  })
})

describe('Embedding serialization', () => {
  test('serializeEmbedding produces a Buffer', () => {
    const vec = [0.1, 0.2, 0.3]
    const buf = serializeEmbedding(vec)
    assert.ok(Buffer.isBuffer(buf))
    assert.equal(buf.length, vec.length * 4) // Float32 = 4 bytes
  })

  test('deserializeEmbedding restores original values', () => {
    const original = [0.1, 0.2, 0.3, 0.4, 0.5]
    const buf = serializeEmbedding(original)
    const restored = deserializeEmbedding(buf)
    assert.equal(restored.length, original.length)
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 0.0001)
    }
  })

  test('handles empty vector', () => {
    const buf = serializeEmbedding([])
    const restored = deserializeEmbedding(buf)
    assert.deepEqual(restored, [])
  })

  test('handles large 384-dim vector', () => {
    const vec = Array.from({ length: 384 }, (_, i) => i * 0.001)
    const buf = serializeEmbedding(vec)
    const restored = deserializeEmbedding(buf)
    assert.equal(restored.length, 384)
    assert.ok(Math.abs(restored[383] - 0.383) < 0.001)
  })

  test('handles negative values', () => {
    const vec = [-1.0, -0.5, 0, 0.5, 1.0]
    const buf = serializeEmbedding(vec)
    const restored = deserializeEmbedding(buf)
    for (let i = 0; i < vec.length; i++) {
      assert.ok(Math.abs(restored[i] - vec[i]) < 0.0001)
    }
  })
})
