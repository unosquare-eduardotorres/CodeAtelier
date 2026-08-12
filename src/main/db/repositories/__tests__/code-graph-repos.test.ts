/**
 * Tests for code-graph and search repositories: CodeGraphTag, CodeGraphEdge,
 * CodeGraphRank, CodeChunk, ChunkEmbedding.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('Code Graph Repositories (skipped — native module unavailable)', () => {
    test('CodeGraphTagRepository upsertTags()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env

  // ─── CodeGraphTagRepository ─────────────────────────────────────────────

  const { CodeGraphTagRepository } = require('../code-graph-tag.repository')
  const tagRepo = new CodeGraphTagRepository()

  describe('CodeGraphTagRepository', () => {
    test('upsertTags() inserts tags for workspace', () => {
      const tags = [
        {
          relFname: 'src/a.ts',
          fname: '/project/src/a.ts',
          line: 10,
          name: 'MyClass',
          kind: 'def' as const
        },
        {
          relFname: 'src/a.ts',
          fname: '/project/src/a.ts',
          line: 20,
          name: 'MyClass',
          kind: 'ref' as const
        },
        {
          relFname: 'src/b.ts',
          fname: '/project/src/b.ts',
          line: 5,
          name: 'helper',
          kind: 'def' as const
        }
      ]
      const mtimes = new Map([
        ['src/a.ts', 1000],
        ['src/b.ts', 2000]
      ])
      // Should not throw
      tagRepo.upsertTags(wsId, tags, mtimes)
    })

    test('findDefsByWorkspace() returns only def tags', () => {
      const tags = [
        {
          relFname: 'src/def.ts',
          fname: '/def.ts',
          line: 1,
          name: 'defOnly',
          kind: 'def' as const
        },
        { relFname: 'src/def.ts', fname: '/def.ts', line: 5, name: 'refOnly', kind: 'ref' as const }
      ]
      tagRepo.upsertTags(wsId, tags, new Map([['src/def.ts', 1000]]))
      const defs = tagRepo.findDefsByWorkspace(wsId)
      assert.ok(defs.length >= 1)
      assert.ok(defs.every((t: any) => t.kind === 'def'))
    })

    test('upsertTags() replaces old tags for same file', () => {
      // Insert initial
      tagRepo.upsertTags(
        wsId,
        [
          { relFname: 'src/replace.ts', fname: '/r.ts', line: 1, name: 'Old', kind: 'def' as const }
        ],
        new Map([['src/replace.ts', 1000]])
      )

      // Replace
      tagRepo.upsertTags(
        wsId,
        [
          { relFname: 'src/replace.ts', fname: '/r.ts', line: 1, name: 'New', kind: 'def' as const }
        ],
        new Map([['src/replace.ts', 2000]])
      )

      const defs = tagRepo.findDefsByWorkspace(wsId)
      const replaced = defs.filter((t: any) => t.relFname === 'src/replace.ts')
      assert.equal(replaced.length, 1)
      assert.equal(replaced[0].name, 'New')
    })

    test('hasUntypedIndex() detects a pre-v130 index and clears once kinds land', () => {
      // Own workspace: the mtime cache bypass keys off this answer, so it must
      // not be perturbed by tags other tests left behind.
      const { seedWorkspace } = require('./db-test-helper')
      const ws = seedWorkspace(env.db, 'ws-untyped-index')

      assert.equal(tagRepo.hasUntypedIndex(ws), false, 'an empty workspace is not an untyped index')

      tagRepo.upsertTags(
        ws,
        [{ relFname: 'src/a.ts', fname: '/a.ts', line: 1, name: 'A', kind: 'def' as const }],
        new Map([['src/a.ts', 1000]])
      )
      assert.equal(tagRepo.hasUntypedIndex(ws), true, 'defs with no symbol_kind owe a re-parse')

      tagRepo.upsertTags(
        ws,
        [
          {
            relFname: 'src/a.ts',
            fname: '/a.ts',
            line: 1,
            name: 'A',
            kind: 'def' as const,
            symbolKind: 'class'
          }
        ],
        new Map([['src/a.ts', 2000]])
      )
      assert.equal(tagRepo.hasUntypedIndex(ws), false, 'a typed index must not re-parse forever')
    })
  })

  // ─── CodeGraphEdgeRepository ────────────────────────────────────────────

  const { CodeGraphEdgeRepository } = require('../code-graph-edge.repository')
  const edgeRepo = new CodeGraphEdgeRepository()

  describe('CodeGraphEdgeRepository', () => {
    test('upsertEdges() inserts edges for workspace', () => {
      const edges = [
        {
          workspaceId: wsId,
          sourceFile: 'src/a.ts',
          sourceSymbol: 'MyClass',
          targetFile: 'src/b.ts',
          targetSymbol: 'helper',
          edgeType: 'calls' as const
        }
      ]
      edgeRepo.upsertEdges(wsId, edges)
    })

    test('findByWorkspace() returns edges including inserted ones', () => {
      const edges = [
        {
          workspaceId: wsId,
          sourceFile: 'src/caller.ts',
          sourceSymbol: 'callFn',
          targetFile: 'src/callee.ts',
          targetSymbol: 'targetFn',
          edgeType: 'calls' as const
        }
      ]
      edgeRepo.upsertEdges(wsId, edges)
      const found = edgeRepo.findByWorkspace(wsId)
      assert.ok(found.length >= 1)
      assert.ok(found.some((e: any) => e.sourceSymbol === 'callFn'))
    })

    test('findCallersOf() returns edges targeting a symbol', () => {
      const found = edgeRepo.findCallersOf(wsId, 'targetFn')
      assert.ok(found.length >= 1)
      assert.ok(found.some((e: any) => e.sourceSymbol === 'callFn'))
    })

    test('deleteByWorkspace() removes all edges', () => {
      const freshWs = 'edge-del-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Edge Del', '/tmp/edge-del')

      edgeRepo.upsertEdges(freshWs, [
        {
          workspaceId: freshWs,
          sourceFile: 'src/x.ts',
          sourceSymbol: 'x',
          targetFile: 'src/y.ts',
          targetSymbol: 'y',
          edgeType: 'calls' as const
        }
      ])
      const count = edgeRepo.deleteByWorkspace(freshWs)
      assert.ok(count >= 1)
    })
  })

  // ─── CodeGraphRankRepository ────────────────────────────────────────────

  const { CodeGraphRankRepository } = require('../code-graph-rank.repository')
  const rankRepo = new CodeGraphRankRepository()

  describe('CodeGraphRankRepository', () => {
    test('upsertRanks() stores PageRank scores', () => {
      const ranks = new Map([
        ['src/a.ts', 0.85],
        ['src/b.ts', 0.15]
      ])
      rankRepo.upsertRanks(wsId, ranks)
    })

    test('findByWorkspace() returns ranks as Map', () => {
      const ranks = new Map([['src/rank.ts', 0.5]])
      rankRepo.upsertRanks(wsId, ranks)
      const found = rankRepo.findByWorkspace(wsId)
      assert.ok(found instanceof Map)
      assert.ok(found.size >= 1)
    })

    test('getRank() returns rank for specific file', () => {
      rankRepo.upsertRanks(wsId, new Map([['src/specific.ts', 0.99]]))
      const rank = rankRepo.getRank(wsId, 'src/specific.ts')
      assert.ok(Math.abs(rank - 0.99) < 0.001)
    })

    test('getRank() returns 0 for unknown file', () => {
      assert.equal(rankRepo.getRank(wsId, 'nonexistent.ts'), 0)
    })

    test('deleteByWorkspace() removes all ranks', () => {
      const freshWs = 'rank-del-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Rank Del', '/tmp/rank-del')

      rankRepo.upsertRanks(freshWs, new Map([['src/x.ts', 0.5]]))
      const count = rankRepo.deleteByWorkspace(freshWs)
      assert.ok(count >= 1)
    })

    test('upsertRanks() replaces existing ranks atomically', () => {
      const freshWs = 'rank-replace-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Rank Replace', '/tmp/rank-replace')

      rankRepo.upsertRanks(
        freshWs,
        new Map([
          ['a.ts', 0.1],
          ['b.ts', 0.2]
        ])
      )
      rankRepo.upsertRanks(freshWs, new Map([['c.ts', 0.3]]))
      const found = rankRepo.findByWorkspace(freshWs)
      // After replacement, only c.ts should exist
      assert.equal(found.size, 1)
      assert.ok(found.has('c.ts'))
    })
  })

  // ─── ChunkEmbeddingRepository ───────────────────────────────────────────

  const {
    ChunkEmbeddingRepository,
    serializeEmbedding,
    deserializeEmbedding
  } = require('../chunk-embedding.repository')
  const embeddingRepo = new ChunkEmbeddingRepository()

  describe('ChunkEmbeddingRepository', () => {
    test('serializeEmbedding() and deserializeEmbedding() round-trip', () => {
      const vec = [0.1, 0.2, 0.3, 0.4, 0.5]
      const blob = serializeEmbedding(vec)
      assert.ok(Buffer.isBuffer(blob))
      const restored = deserializeEmbedding(blob)
      assert.equal(restored.length, 5)
      for (let i = 0; i < vec.length; i++) {
        assert.ok(Math.abs(restored[i] - vec[i]) < 0.0001)
      }
    })

    test('upsertEmbeddings() stores embeddings', () => {
      // First create a code chunk to satisfy FK
      env.db
        .prepare(
          `
        INSERT OR IGNORE INTO code_chunks (id, workspace_id, file_path, file_name, directory, symbol_name, symbol_kind, signature, start_line, end_line, language, body, embed_text, is_public, is_async, has_docstring, line_count, file_mtime)
        VALUES ('chunk-emb-1', ?, 'src/emb.ts', 'emb.ts', 'src', 'fn', 'function', 'fn()', 1, 10, 'typescript', 'body', 'embed text', 1, 0, 0, 10, 1000)
      `
        )
        .run(wsId)

      const entries = [{ chunkId: 'chunk-emb-1', embedding: [0.1, 0.2, 0.3], model: 'test-model' }]
      embeddingRepo.upsertEmbeddings(wsId, entries)
    })

    test('loadAllForWorkspace() returns stored embeddings', () => {
      const entries = embeddingRepo.loadAllForWorkspace(wsId)
      assert.ok(entries.length >= 1)
      const entry = entries.find((e: any) => e.chunkId === 'chunk-emb-1')
      assert.ok(entry)
      assert.equal(entry.embedding.length, 3)
      assert.equal(entry.model, 'test-model')
    })

    test('deleteByWorkspace() removes all embeddings for workspace', () => {
      const freshWs = 'emb-del-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Emb Del', '/tmp/emb-del')

      // Create chunk + embedding
      env.db
        .prepare(
          `
        INSERT OR IGNORE INTO code_chunks (id, workspace_id, file_path, file_name, directory, symbol_name, symbol_kind, signature, start_line, end_line, language, body, embed_text, is_public, is_async, has_docstring, line_count, file_mtime)
        VALUES ('chunk-del-1', ?, 'src/del.ts', 'del.ts', 'src', 'fn', 'function', 'fn()', 1, 5, 'typescript', 'body', 'text', 1, 0, 0, 5, 1000)
      `
        )
        .run(freshWs)
      embeddingRepo.upsertEmbeddings(freshWs, [
        { chunkId: 'chunk-del-1', embedding: [0.5], model: 'test' }
      ])

      const count = embeddingRepo.deleteByWorkspace(freshWs)
      assert.ok(count >= 1)
      assert.equal(embeddingRepo.loadAllForWorkspace(freshWs).length, 0)
    })
  })
}
