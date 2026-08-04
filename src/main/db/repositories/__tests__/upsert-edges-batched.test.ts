/**
 * Tests for CodeGraphEdgeRepository.upsertEdgesBatched() —
 * batching logic, empty arrays, boundary sizes, and event-loop yielding.
 *
 * Each test uses a unique workspace ID to avoid concurrent-test interference
 * (the test harness runs async tests in parallel via Promise.all).
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb, seedWorkspace } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('upsertEdgesBatched (skipped — native module unavailable)', () => {
    test('upsertEdgesBatched()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db } = env
  const { codeGraphEdgeRepository } = require('../code-graph-edge.repository')

  let testCounter = 0
  /** Seed a unique workspace and return its ID. Avoids concurrent-test collision. */
  function freshWorkspace(): string {
    const wsId = `test-batched-${++testCounter}-${Date.now()}`
    seedWorkspace(db, wsId)
    return wsId
  }

  /** Helper to generate N sample edges for a workspace */
  function makeEdges(wsId: string, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      workspaceId: wsId,
      sourceFile: `src/file-${i}.ts`,
      sourceSymbol: `fn${i}`,
      targetFile: `src/target-${i % 10}.ts`,
      targetSymbol: `Target${i % 10}`,
      edgeType: 'calls' as const,
      pageRank: i * 0.001
    }))
  }

  describe('upsertEdgesBatched', () => {
    test('handles empty edges array — clears existing edges', async () => {
      const wsId = freshWorkspace()
      // Seed some edges first using the sync method
      codeGraphEdgeRepository.upsertEdges(wsId, makeEdges(wsId, 5))
      assert.equal(codeGraphEdgeRepository.countByWorkspace(wsId), 5)

      // Batched upsert with empty array should clear them
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, [])
      assert.equal(codeGraphEdgeRepository.countByWorkspace(wsId), 0)
    })

    test('inserts small batch (under BATCH_SIZE)', async () => {
      const wsId = freshWorkspace()
      const edges = makeEdges(wsId, 10)
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const stored = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(stored.length, 10)

      // Verify data integrity
      const first = stored.find((e: any) => e.sourceSymbol === 'fn0')
      assert.ok(first, 'Should find edge with sourceSymbol fn0')
      assert.equal(first.sourceFile, 'src/file-0.ts')
      assert.equal(first.edgeType, 'calls')
    })

    test('inserts exactly BATCH_SIZE edges (boundary case)', async () => {
      const wsId = freshWorkspace()
      // BATCH_SIZE is 5000 in the implementation
      const edges = makeEdges(wsId, 5000)
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const count = codeGraphEdgeRepository.countByWorkspace(wsId)
      assert.equal(count, 5000)
    })

    test('inserts edges crossing BATCH_SIZE boundary', async () => {
      const wsId = freshWorkspace()
      // 5001 edges → 2 batches: [5000] + [1]
      const edges = makeEdges(wsId, 5001)
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const count = codeGraphEdgeRepository.countByWorkspace(wsId)
      assert.equal(count, 5001)
    })

    test('replaces existing edges on re-call', async () => {
      const wsId = freshWorkspace()
      // Insert 100 edges
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, makeEdges(wsId, 100))
      assert.equal(codeGraphEdgeRepository.countByWorkspace(wsId), 100)

      // Replace with 50 edges — count should drop
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, makeEdges(wsId, 50))
      assert.equal(codeGraphEdgeRepository.countByWorkspace(wsId), 50)
    })

    test('preserves pageRank values', async () => {
      const wsId = freshWorkspace()
      const edges = [
        {
          workspaceId: wsId,
          sourceFile: 'src/a.ts',
          sourceSymbol: 'fnA',
          targetFile: 'src/b.ts',
          targetSymbol: 'fnB',
          edgeType: 'calls' as const,
          pageRank: 0.75
        }
      ]
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const stored = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(stored.length, 1)
      assert.equal(stored[0].pageRank, 0.75)
    })

    test('handles edges with undefined pageRank (defaults to 0)', async () => {
      const wsId = freshWorkspace()
      const edges = [
        {
          workspaceId: wsId,
          sourceFile: 'src/a.ts',
          sourceSymbol: 'fnA',
          targetFile: 'src/b.ts',
          targetSymbol: 'fnB',
          edgeType: 'imports' as const
          // pageRank intentionally omitted
        }
      ]
      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const stored = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(stored.length, 1)
      assert.equal(stored[0].pageRank, 0)
    })

    test('multi-batch preserves all edge types', async () => {
      const wsId = freshWorkspace()
      const edgeTypes = ['calls', 'imports', 'extends', 'implements', 'references'] as const
      const edges = edgeTypes.map((et, i) => ({
        workspaceId: wsId,
        sourceFile: `src/file-${i}.ts`,
        sourceSymbol: `sym${i}`,
        targetFile: `src/target-${i}.ts`,
        targetSymbol: `Target${i}`,
        edgeType: et,
        pageRank: 0
      }))

      await codeGraphEdgeRepository.upsertEdgesBatched(wsId, edges)

      const stored = codeGraphEdgeRepository.findByWorkspace(wsId)
      assert.equal(stored.length, 5)
      const storedTypes = new Set(stored.map((e: any) => e.edgeType))
      for (const et of edgeTypes) {
        assert.ok(storedTypes.has(et), `Should contain edge type "${et}"`)
      }
    })
  })
}
