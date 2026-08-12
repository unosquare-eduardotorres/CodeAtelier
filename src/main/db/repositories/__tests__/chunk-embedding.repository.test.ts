/**
 * Tests for ChunkEmbeddingRepository — serialization, upsert, load, hasEmbeddings.
 * Also tests pure-logic serializeEmbedding/deserializeEmbedding (no DB needed).
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

// ── Pure-logic tests: serialize/deserialize (no DB) ──

describe('serializeEmbedding / deserializeEmbedding (pure logic)', () => {
  // Inline the functions to test without DB import chain side effects
  function serializeEmbedding(vec: number[]): Buffer {
    return Buffer.from(new Float32Array(vec).buffer)
  }
  function deserializeEmbedding(blob: Buffer): number[] {
    return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4))
  }

  test('round-trip preserves values', () => {
    const original = [0.1, 0.2, 0.3, -0.5, 1.0]
    const buf = serializeEmbedding(original)
    const restored = deserializeEmbedding(buf)
    assert.equal(restored.length, original.length)
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `Mismatch at index ${i}`)
    }
  })

  test('empty vector round-trips', () => {
    const buf = serializeEmbedding([])
    const restored = deserializeEmbedding(buf)
    assert.equal(restored.length, 0)
  })

  test('serialized buffer size is 4 bytes per float', () => {
    const vec = [1.0, 2.0, 3.0]
    const buf = serializeEmbedding(vec)
    assert.equal(buf.byteLength, 12) // 3 * 4 bytes
  })

  test('high-dimensional vector (384-dim) round-trips', () => {
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i))
    const buf = serializeEmbedding(vec)
    const restored = deserializeEmbedding(buf)
    assert.equal(restored.length, 384)
    assert.ok(Math.abs(restored[0] - Math.sin(0)) < 1e-6)
    assert.ok(Math.abs(restored[383] - Math.sin(383)) < 1e-6)
  })
})

const env = trySetupTestDb()

if (!env) {
  describe('ChunkEmbeddingRepository (skipped — native module unavailable)', () => {
    test('upsertEmbeddings()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { chunkEmbeddingRepository } = require('../chunk-embedding.repository')

  // Seed code_chunks rows for FK satisfaction
  const seedChunk = (id: string) => {
    db.prepare(
      `INSERT OR IGNORE INTO code_chunks
      (id, workspace_id, file_path, file_name, directory, symbol_name, symbol_kind,
       signature, start_line, end_line, language, body, embed_text, is_public,
       is_async, has_docstring, line_count, file_mtime)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      wsId,
      'src/x.ts',
      'x.ts',
      'src',
      'fn',
      'function',
      'fn(): void',
      1,
      3,
      'typescript',
      'fn() {}',
      'fn',
      1,
      0,
      0,
      3,
      1000
    )
  }

  describe('ChunkEmbeddingRepository', () => {
    test('upsertEmbeddings() + loadAllForWorkspace() round-trip', () => {
      seedChunk('emb-chunk-1')
      seedChunk('emb-chunk-2')

      const entries = [
        { chunkId: 'emb-chunk-1', embedding: [0.1, 0.2, 0.3], model: 'all-MiniLM-L6-v2' },
        { chunkId: 'emb-chunk-2', embedding: [0.4, 0.5, 0.6], model: 'all-MiniLM-L6-v2' }
      ]
      chunkEmbeddingRepository.upsertEmbeddings(wsId, entries)

      const loaded = chunkEmbeddingRepository.loadAllForWorkspace(wsId)
      assert.equal(loaded.length, 2)

      const first = loaded.find((e: any) => e.chunkId === 'emb-chunk-1')
      assert.ok(first)
      assert.equal(first.model, 'all-MiniLM-L6-v2')
      assert.equal(first.embedding.length, 3)
      assert.ok(Math.abs(first.embedding[0] - 0.1) < 1e-6)
    })

    test('hasEmbeddings() returns true when embeddings exist', () => {
      assert.equal(chunkEmbeddingRepository.hasEmbeddings(wsId), true)
    })

    test('hasEmbeddings() returns false for empty workspace', () => {
      const row = db
        .prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
        .get('EmptyWS', '/tmp/empty') as { id: string }
      assert.equal(chunkEmbeddingRepository.hasEmbeddings(row.id), false)
    })

    test('countByWorkspace() returns correct count', () => {
      const count = chunkEmbeddingRepository.countByWorkspace(wsId)
      assert.equal(count, 2)
    })

    test('upsertEmbeddings() replaces existing (INSERT OR REPLACE)', () => {
      const updated = [{ chunkId: 'emb-chunk-1', embedding: [0.9, 0.8, 0.7], model: 'new-model' }]
      chunkEmbeddingRepository.upsertEmbeddings(wsId, updated)
      const loaded = chunkEmbeddingRepository.loadAllForWorkspace(wsId)
      const first = loaded.find((e: any) => e.chunkId === 'emb-chunk-1')
      assert.equal(first!.model, 'new-model')
      assert.ok(Math.abs(first!.embedding[0] - 0.9) < 1e-6)
    })

    test('deleteByWorkspace() clears embeddings', () => {
      const deleted = chunkEmbeddingRepository.deleteByWorkspace(wsId)
      assert.ok(deleted >= 2)
      assert.equal(chunkEmbeddingRepository.countByWorkspace(wsId), 0)
    })
  })
}
