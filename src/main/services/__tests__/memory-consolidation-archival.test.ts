/**
 * memory-consolidation-archival.test.ts — DB-backed integration test for
 * the stale-T0 archival predicate.
 *
 * Exercises `selectStaleT0Facts` + `hasRealEvidence` against a real seeded
 * in-memory DB, covering the composed filter + getConfirmations wiring.
 *
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

let dbAvailable = false
let createTestDb: typeof import('../../db/test-helpers').createTestDb
let seedWorkspace: typeof import('../../db/test-helpers').seedWorkspace
let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
let memoryFactRepository: typeof import('../../db/repositories/memory-fact.repository').memoryFactRepository
let selectStaleT0Facts: typeof import('../memory-consolidation.service').selectStaleT0Facts
let hasRealEvidence: typeof import('../memory-consolidation.service').hasRealEvidence

try {
  createTestDb = require('../../db/test-helpers').createTestDb
  seedWorkspace = require('../../db/test-helpers').seedWorkspace
  _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
  memoryFactRepository =
    require('../../db/repositories/memory-fact.repository').memoryFactRepository
  const consolidationMod = require('../memory-consolidation.service')
  selectStaleT0Facts = consolidationMod.selectStaleT0Facts
  hasRealEvidence = consolidationMod.hasRealEvidence
  const probe = createTestDb()
  probe.close()
  dbAvailable = true
} catch {
  dbAvailable = false
}

if (dbAvailable) {
  describe('selectStaleT0Facts + hasRealEvidence (DB-backed)', () => {
    /**
     * Seed five facts with different characteristics:
     *
     * Fact A — T0, 40d old, no lastAccessedAt, 2× auto_dedup only → SELECTED
     * Fact B — T0, 40d old, no lastAccessedAt, 1× extraction       → NOT (real evidence)
     * Fact C — T0, 40d old, lastAccessedAt set                      → NOT (accessed guard)
     * Fact D — T0, 5d old, no confirmations                         → NOT (not stale)
     * Fact E — global (null workspace), T0, 40d old, no confirms    → NOT (workspace guard)
     */
    test('selects only facts matching all stale-T0 archival criteria', () => {
      const db = createTestDb()
      _setDatabaseForTesting(db)
      const ws = seedWorkspace(db)

      // ── Create facts ──
      const factA = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact A — stale T0, auto_dedup only',
        content: 'Should be selected',
        sourceType: 'session',
        embeddingPending: false
      })

      const factB = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact B — real evidence',
        content: 'Should NOT be selected',
        sourceType: 'session',
        embeddingPending: false
      })

      const factC = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact C — accessed',
        content: 'Should NOT be selected',
        sourceType: 'session',
        embeddingPending: false
      })

      const factD = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact D — fresh',
        content: 'Should NOT be selected',
        sourceType: 'session',
        embeddingPending: false
      })

      const factE = memoryFactRepository.createFact({
        workspaceId: null,
        category: 'convention',
        title: 'Fact E — global',
        content: 'Should NOT be selected',
        sourceType: 'session',
        embeddingPending: false
      })

      // ── Back-date A, B, C, E to 40 days ago ──
      const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare(`UPDATE memory_facts SET created_at = ? WHERE id IN (?, ?, ?, ?)`).run(
        staleDate,
        factA.id,
        factB.id,
        factC.id,
        factE.id
      )

      // ── Fact D stays fresh (5 days ago) ──
      const freshDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare(`UPDATE memory_facts SET created_at = ? WHERE id = ?`).run(freshDate, factD.id)

      // ── Add confirmations ──
      // Fact A: 2× auto_dedup (no real evidence)
      memoryFactRepository.addConfirmation(factA.id, 'auto_dedup', 0)
      memoryFactRepository.addConfirmation(factA.id, 'auto_dedup', 0)

      // Fact B: 1× extraction (real evidence)
      memoryFactRepository.addConfirmation(factB.id, 'extraction', 1)

      // Fact C: set lastAccessedAt
      memoryFactRepository.touchFacts([factC.id])

      // ── Run the selector ──
      const activeFacts = memoryFactRepository.findByWorkspace(ws, 'active')
      const selected = selectStaleT0Facts(activeFacts, ws, (id) => hasRealEvidence(id))

      // ── Assertions ──
      const selectedIds = selected.map((f) => f.id)
      assert.equal(selectedIds.length, 1, `Expected exactly 1 selected, got ${selectedIds.length}`)
      assert.ok(
        selectedIds.includes(factA.id),
        'Fact A should be selected (stale T0, auto_dedup only)'
      )
      assert.ok(
        !selectedIds.includes(factB.id),
        'Fact B should NOT be selected (has extraction confirmation)'
      )
      assert.ok(
        !selectedIds.includes(factC.id),
        'Fact C should NOT be selected (lastAccessedAt set)'
      )
      assert.ok(!selectedIds.includes(factD.id), 'Fact D should NOT be selected (too fresh)')
      assert.ok(!selectedIds.includes(factE.id), 'Fact E should NOT be selected (global fact)')

      db.close()
    })

    test('getEvidenceCounts returns only non-auto_dedup confirmations', () => {
      const db = createTestDb()
      _setDatabaseForTesting(db)
      const ws = seedWorkspace(db)

      // Fact with 2× auto_dedup + 1× human → evidence count 1
      const factWithHuman = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact with human evidence',
        content: 'Has real evidence',
        sourceType: 'session',
        embeddingPending: false
      })
      memoryFactRepository.addConfirmation(factWithHuman.id, 'auto_dedup', 0)
      memoryFactRepository.addConfirmation(factWithHuman.id, 'auto_dedup', 0)
      memoryFactRepository.addConfirmation(factWithHuman.id, 'human', 1)

      // Fact with only auto_dedup → absent from map (treated as 0)
      const factDedupOnly = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact with auto_dedup only',
        content: 'No real evidence',
        sourceType: 'session',
        embeddingPending: false
      })
      memoryFactRepository.addConfirmation(factDedupOnly.id, 'auto_dedup', 0)
      memoryFactRepository.addConfirmation(factDedupOnly.id, 'auto_dedup', 0)

      // Fact with no confirmations at all
      const factNone = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Fact with no confirmations',
        content: 'Zero evidence',
        sourceType: 'session',
        embeddingPending: false
      })

      // ── Test batch query ──
      const counts = memoryFactRepository.getEvidenceCounts([
        factWithHuman.id,
        factDedupOnly.id,
        factNone.id
      ])

      assert.equal(
        counts.get(factWithHuman.id),
        1,
        'Human-confirmed fact should have evidence count 1'
      )
      assert.equal(
        counts.has(factDedupOnly.id),
        false,
        'Auto-dedup-only fact should be absent from map'
      )
      assert.equal(counts.has(factNone.id), false, 'No-confirmation fact should be absent from map')

      // ── Empty input returns empty map ──
      const empty = memoryFactRepository.getEvidenceCounts([])
      assert.equal(empty.size, 0, 'Empty input should return empty map')

      db.close()
    })

    test('archival flips status to archived for selected facts', () => {
      const db = createTestDb()
      _setDatabaseForTesting(db)
      const ws = seedWorkspace(db)

      // Create a fact that qualifies for archival
      const fact = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Stale fact for archival',
        content: 'Should be archived',
        sourceType: 'session',
        embeddingPending: false
      })

      // Back-date to 40 days ago
      const staleDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
      db.prepare(`UPDATE memory_facts SET created_at = ? WHERE id = ?`).run(staleDate, fact.id)

      // Add only auto_dedup confirmations (no real evidence)
      memoryFactRepository.addConfirmation(fact.id, 'auto_dedup', 0)

      // Also create a fact that should NOT be archived (has real evidence)
      const protectedFact = memoryFactRepository.createFact({
        workspaceId: ws,
        category: 'convention',
        title: 'Protected fact',
        content: 'Should stay active',
        sourceType: 'session',
        embeddingPending: false
      })
      db.prepare(`UPDATE memory_facts SET created_at = ? WHERE id = ?`).run(
        staleDate,
        protectedFact.id
      )
      memoryFactRepository.addConfirmation(protectedFact.id, 'human', 1)

      // Run selection + archival (the production path)
      const active = memoryFactRepository.findByWorkspace(ws, 'active')
      const stale = selectStaleT0Facts(active, ws, (id) => hasRealEvidence(id))
      for (const f of stale) memoryFactRepository.archiveFact(f.id)

      // Verify: stale fact is now archived
      const afterActive = memoryFactRepository.findByWorkspace(ws, 'active')
      const afterActiveIds = afterActive.map((f) => f.id)
      assert.ok(!afterActiveIds.includes(fact.id), 'Stale fact should no longer be active')
      assert.ok(afterActiveIds.includes(protectedFact.id), 'Protected fact should remain active')

      // Double-check via archived status
      const archived = memoryFactRepository.findByWorkspace(ws, 'archived')
      const archivedIds = archived.map((f) => f.id)
      assert.ok(archivedIds.includes(fact.id), 'Stale fact should appear in archived list')

      db.close()
    })
  })
} else {
  test('memory-consolidation-archival: SKIPPED (better-sqlite3 unavailable)', () => {
    assert.ok(true, 'Skipped — native module not available in this environment')
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
