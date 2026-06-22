/**
 * Unit tests for CodeGraphRankRepository — stores pre-computed PageRank scores
 * for file ranking during graph map generation.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('CodeGraphRankRepository (skipped — native module unavailable)', () => {
    test('placeholder', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db: _db, wsId } = env
  const { codeGraphRankRepository } = require('../code-graph-rank.repository')

  describe('CodeGraphRankRepository', () => {
    // ── upsertRanks + findByWorkspace ──

    test('upsertRanks() inserts ranks retrievable by findByWorkspace()', () => {
      const ranks = new Map<string, number>([
        ['src/app.ts', 0.95],
        ['src/utils.ts', 0.42],
        ['src/index.ts', 0.78]
      ])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      const result = codeGraphRankRepository.findByWorkspace(wsId)
      assert.equal(result.size, 3)
      assert.equal(result.get('src/app.ts'), 0.95)
      assert.equal(result.get('src/utils.ts'), 0.42)
    })

    test('upsertRanks() replaces all existing ranks atomically', () => {
      const initial = new Map([['old.ts', 0.5]])
      codeGraphRankRepository.upsertRanks(wsId, initial)
      assert.equal(codeGraphRankRepository.findByWorkspace(wsId).size, 1)

      const replacement = new Map([['new1.ts', 0.8], ['new2.ts', 0.6]])
      codeGraphRankRepository.upsertRanks(wsId, replacement)
      const result = codeGraphRankRepository.findByWorkspace(wsId)
      assert.equal(result.size, 2)
      assert.equal(result.has('old.ts'), false)
      assert.equal(result.get('new1.ts'), 0.8)
    })

    // ── getRank ──

    test('getRank() returns score for known file', () => {
      const ranks = new Map([['ranked.ts', 0.75]])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      assert.equal(codeGraphRankRepository.getRank(wsId, 'ranked.ts'), 0.75)
    })

    test('getRank() returns 0 for unknown file', () => {
      assert.equal(codeGraphRankRepository.getRank(wsId, 'nonexistent.ts'), 0)
    })

    // ── countByWorkspace ──

    test('countByWorkspace() returns correct count', () => {
      const ranks = new Map([['a.ts', 0.1], ['b.ts', 0.2], ['c.ts', 0.3]])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      assert.equal(codeGraphRankRepository.countByWorkspace(wsId), 3)
    })

    // ── getTopRanked ──

    test('getTopRanked() returns files ordered by rank descending', () => {
      const ranks = new Map([
        ['low.ts', 0.1],
        ['high.ts', 0.9],
        ['mid.ts', 0.5]
      ])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      const top = codeGraphRankRepository.getTopRanked(wsId, 2)
      assert.equal(top.length, 2)
      assert.equal(top[0], 'high.ts')
      assert.equal(top[1], 'mid.ts')
    })

    test('getTopRanked() respects limit', () => {
      const ranks = new Map([['a.ts', 0.1], ['b.ts', 0.2], ['c.ts', 0.3]])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      assert.equal(codeGraphRankRepository.getTopRanked(wsId, 1).length, 1)
    })

    // ── deleteByWorkspace ──

    test('deleteByWorkspace() removes all ranks and returns count', () => {
      const ranks = new Map([['x.ts', 0.5], ['y.ts', 0.6]])
      codeGraphRankRepository.upsertRanks(wsId, ranks)
      const deleted = codeGraphRankRepository.deleteByWorkspace(wsId)
      assert.equal(deleted, 2)
      assert.equal(codeGraphRankRepository.countByWorkspace(wsId), 0)
    })

    // ── findByWorkspace edge case ──

    test('findByWorkspace() returns empty Map for unknown workspace', () => {
      const result = codeGraphRankRepository.findByWorkspace('unknown-ws-id')
      assert.equal(result.size, 0)
    })
  })
}
