/**
 * memory-promotion-evidence.test.ts
 *
 * Two behaviours introduced alongside "retrieval is evidence":
 *
 *   - `recordRetrievalConfirmations` is rate-limited to one row per fact per
 *     calendar day. Without that cap a single chatty session would manufacture
 *     arbitrary evidence, and the promotion gates count *distinct days*
 *     precisely so the claim being made is "this was relevant on N separate
 *     days of work".
 *
 *   - `promotionDiagnostics` explains why a fact is still at T0. It exists
 *     because the original report ("nothing is ever promoted") was purely
 *     observational and there was no way to check it.
 *
 * Also pinned: writing retrieval evidence must NOT touch
 * `memory_facts.updated_at`. That column is what `getLastMutationAt` reads to
 * invalidate the workspace embedding cache, so bumping it once per retrieval
 * would rebuild the cache constantly.
 */

import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { attachTestDb, liveTestDb } from './db-test-helper'
import {
  MEMORY_RETRIEVAL_CONFIDENCE_CEILING,
  MEMORY_RETRIEVAL_CONFIDENCE_RECOVERY,
  MEMORY_RETRIEVAL_CONFIRMATION_WEIGHT,
  MEMORY_T0_PROMOTION_MIN_CONFIDENCE
} from '../../../../shared/types'

const env = attachTestDb()

if (!env) {
  describe('memory promotion evidence (skipped — native module unavailable)', () => {
    test('retrieval confirmations', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env

  let repo: any = null
  try {
    repo = require('../../repositories/memory-fact.repository').memoryFactRepository
  } catch (err) {
    console.log(`⚠ memory-fact.repository load failed: ${(err as Error).message?.split('\n')[0]}`)
  }

  if (!repo) {
    describe('memory promotion evidence (skipped — repository unavailable)', () => {
      test('retrieval confirmations', () => {}, { skipReason: 'no repo' })
    })
  } else {
    let seq = 0

    function makeFact(overrides: { tier?: number; confidence?: number; volatile?: number } = {}) {
      const fact = repo.createFact({
        workspaceId: wsId,
        category: 'convention',
        title: `Evidence fact ${++seq}`,
        content: `Body ${seq}`,
        tags: [],
        sourceType: 'manual'
      })
      const db = liveTestDb()
      db.prepare(`UPDATE memory_facts SET tier = ?, confidence = ?, volatile = ? WHERE id = ?`).run(
        overrides.tier ?? 0,
        overrides.confidence ?? 0.5,
        overrides.volatile ?? 0,
        fact.id
      )
      return fact.id
    }

    /** Rows in memory_confirmations for a fact, oldest first. */
    function confirmationsFor(factId: string): Array<{ source_type: string; weight: number }> {
      return liveTestDb()
        .prepare(
          'SELECT source_type, weight FROM memory_confirmations WHERE fact_id = ? ORDER BY created_at ASC'
        )
        .all(factId) as never
    }

    /** Insert a confirmation dated `daysAgo` days back. */
    function seedConfirmation(factId: string, sourceType: string, daysAgo: number): void {
      liveTestDb()
        .prepare(
          `INSERT INTO memory_confirmations (fact_id, source_type, weight, created_at)
           VALUES (?, ?, 1.0, datetime('now', ?))`
        )
        .run(factId, sourceType, `-${daysAgo} days`)
    }

    // ── Rate limiting ──────────────────────────────────────────────────────

    describe('recordRetrievalConfirmations', () => {
      test('writes one confirmation for a fact with none today', () => {
        const id = makeFact()
        const written = repo.recordRetrievalConfirmations([id])
        assert.equal(written, 1)

        const rows = confirmationsFor(id)
        assert.equal(rows.length, 1)
        assert.equal(rows[0].source_type, 'retrieval')
        assert.equal(rows[0].weight, MEMORY_RETRIEVAL_CONFIRMATION_WEIGHT)
      })

      test('is capped at one per fact per calendar day', () => {
        const id = makeFact()
        assert.equal(repo.recordRetrievalConfirmations([id]), 1)
        assert.equal(
          repo.recordRetrievalConfirmations([id]),
          0,
          'second call same day writes nothing'
        )
        assert.equal(repo.recordRetrievalConfirmations([id]), 0)
        assert.equal(repo.recordRetrievalConfirmations([id]), 0)

        assert.equal(confirmationsFor(id).length, 1, 'exactly one retrieval row survives the day')
      })

      test('a retrieval confirmation from a previous day does not block today', () => {
        const id = makeFact()
        seedConfirmation(id, 'retrieval', 1) // yesterday
        assert.equal(repo.recordRetrievalConfirmations([id]), 1)
        assert.equal(confirmationsFor(id).length, 2)
      })

      test('the cap is per source type — an extraction today does not block retrieval', () => {
        const id = makeFact()
        seedConfirmation(id, 'extraction', 0) // today
        assert.equal(repo.recordRetrievalConfirmations([id]), 1)

        const kinds = confirmationsFor(id).map((r) => r.source_type)
        assert.deepEqual(kinds.sort(), ['extraction', 'retrieval'])
      })

      test('handles a batch, skipping only the facts already confirmed today', () => {
        const a = makeFact()
        const b = makeFact()
        const c = makeFact()
        repo.recordRetrievalConfirmations([b]) // b already has today's row

        assert.equal(repo.recordRetrievalConfirmations([a, b, c]), 2, 'a and c written, b skipped')
        assert.equal(confirmationsFor(a).length, 1)
        assert.equal(confirmationsFor(b).length, 1)
        assert.equal(confirmationsFor(c).length, 1)
      })

      test('an empty batch is a no-op', () => {
        assert.equal(repo.recordRetrievalConfirmations([]), 0)
      })

      test('a day with a retrieval row regains a sliver of confidence', () => {
        const id = makeFact({ confidence: 0.2 })
        repo.recordRetrievalConfirmations([id])

        const row = liveTestDb()
          .prepare('SELECT confidence FROM memory_facts WHERE id = ?')
          .get(id) as { confidence: number }
        assert.ok(
          Math.abs(row.confidence - (0.2 + MEMORY_RETRIEVAL_CONFIDENCE_RECOVERY)) < 1e-9,
          `expected ${0.2 + MEMORY_RETRIEVAL_CONFIDENCE_RECOVERY}, got ${row.confidence}`
        )
      })

      test('a rate-limited repeat on the same day does NOT recover again', () => {
        const id = makeFact({ confidence: 0.2 })
        repo.recordRetrievalConfirmations([id])
        repo.recordRetrievalConfirmations([id])
        repo.recordRetrievalConfirmations([id])

        const row = liveTestDb()
          .prepare('SELECT confidence FROM memory_facts WHERE id = ?')
          .get(id) as { confidence: number }
        assert.ok(
          Math.abs(row.confidence - (0.2 + MEMORY_RETRIEVAL_CONFIDENCE_RECOVERY)) < 1e-9,
          'recovery is per day, not per retrieval'
        )
      })

      test('recovery is capped at the fresh-observation ceiling', () => {
        // Just below the ceiling: a full step would overshoot, so it clamps.
        const id = makeFact({ confidence: MEMORY_RETRIEVAL_CONFIDENCE_CEILING - 0.005 })
        repo.recordRetrievalConfirmations([id])

        const row = liveTestDb()
          .prepare('SELECT confidence FROM memory_facts WHERE id = ?')
          .get(id) as { confidence: number }
        assert.ok(
          Math.abs(row.confidence - MEMORY_RETRIEVAL_CONFIDENCE_CEILING) < 1e-9,
          `expected clamp to ${MEMORY_RETRIEVAL_CONFIDENCE_CEILING}, got ${row.confidence}`
        )
      })

      test('a fact already at or above the ceiling is left alone', () => {
        const id = makeFact({ confidence: 0.9 })
        repo.recordRetrievalConfirmations([id])

        const row = liveTestDb()
          .prepare('SELECT confidence FROM memory_facts WHERE id = ?')
          .get(id) as { confidence: number }
        assert.equal(row.confidence, 0.9, 'usage must never inflate real confidence')
      })

      test('sustained daily use lifts a decayed fact back over the promotion floor', () => {
        // The trap this recovery exists to break: decayed to 0.25, retrieved
        // every day. Simulate distinct days by ageing yesterday's row.
        const id = makeFact({ confidence: 0.25 })
        const db = liveTestDb()
        for (let day = 0; day < 12; day++) {
          repo.recordRetrievalConfirmations([id])
          // Age today's row so tomorrow's call is not rate-limited.
          db.prepare(
            `UPDATE memory_confirmations SET created_at = datetime(created_at, '-1 day')
              WHERE fact_id = ? AND source_type = 'retrieval'`
          ).run(id)
        }

        const row = db.prepare('SELECT confidence FROM memory_facts WHERE id = ?').get(id) as {
          confidence: number
        }
        assert.ok(
          row.confidence >= MEMORY_T0_PROMOTION_MIN_CONFIDENCE,
          `12 days of use should clear the ${MEMORY_T0_PROMOTION_MIN_CONFIDENCE} floor, got ${row.confidence}`
        )
      })

      test('does not bump memory_facts.updated_at (embedding cache guard)', () => {
        const id = makeFact()
        const db = liveTestDb()
        db.prepare(`UPDATE memory_facts SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(
          id
        )

        repo.recordRetrievalConfirmations([id])

        const row = db
          .prepare('SELECT updated_at, confidence FROM memory_facts WHERE id = ?')
          .get(id) as { updated_at: string; confidence: number }
        assert.equal(row.updated_at, '2020-01-01 00:00:00', 'updated_at must not move')
        assert.equal(
          row.confidence,
          MEMORY_RETRIEVAL_CONFIDENCE_CEILING,
          'a fact already at the ceiling gains nothing — recovery only undoes decay'
        )
      })
    })

    // ── Diagnostics ────────────────────────────────────────────────────────

    describe('promotionDiagnostics', () => {
      test('tier histogram counts active facts per tier', () => {
        const before = repo.promotionDiagnostics(wsId)
        makeFact({ tier: 0 })
        makeFact({ tier: 1 })
        makeFact({ tier: 1 })
        makeFact({ tier: 3 })

        const after = repo.promotionDiagnostics(wsId)
        assert.equal(after.tierCounts[0] - before.tierCounts[0], 1)
        assert.equal(after.tierCounts[1] - before.tierCounts[1], 2)
        assert.equal(after.tierCounts[2] - before.tierCounts[2], 0)
        assert.equal(after.tierCounts[3] - before.tierCounts[3], 1)
      })

      test('a T0 fact short of distinct days lands in needsMoreDays', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: 0.9 })
        // 3 confirms, but only 2 distinct days
        seedConfirmation(id, 'extraction', 0)
        seedConfirmation(id, 'tool', 0)
        seedConfirmation(id, 'human', 1)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.needsMoreDays - before.needsMoreDays, 1)
        assert.equal(after.needsConfidence - before.needsConfidence, 0)
        assert.equal(after.awaitingSweep - before.awaitingSweep, 0)
        assert.equal(after.total - before.total, 1)
      })

      test('a decayed T0 fact with enough days lands in needsConfidence', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: MEMORY_T0_PROMOTION_MIN_CONFIDENCE - 0.1 })
        seedConfirmation(id, 'extraction', 0)
        seedConfirmation(id, 'tool', 1)
        seedConfirmation(id, 'human', 2)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.needsConfidence - before.needsConfidence, 1)
        assert.equal(after.needsMoreDays - before.needsMoreDays, 0)
      })

      test('a fact passing every gate lands in awaitingSweep', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: 0.8 })
        seedConfirmation(id, 'extraction', 0)
        seedConfirmation(id, 'tool', 1)
        seedConfirmation(id, 'human', 2)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.awaitingSweep - before.awaitingSweep, 1)
      })

      test('auto_dedup confirmations do not make a fact look promotable', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: 0.8 })
        seedConfirmation(id, 'auto_dedup', 0)
        seedConfirmation(id, 'auto_dedup', 1)
        seedConfirmation(id, 'auto_dedup', 2)
        seedConfirmation(id, 'auto_dedup', 3)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.total - before.total, 0, 'repetition is not evidence')
      })

      test('retrieval confirmations DO count toward the T0 evidence bar', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: 0.8 })
        seedConfirmation(id, 'retrieval', 0)
        seedConfirmation(id, 'retrieval', 1)
        seedConfirmation(id, 'retrieval', 2)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.awaitingSweep - before.awaitingSweep, 1, 'usage alone can reach T1')
      })

      test('volatile facts are never reported as stuck', () => {
        const before = repo.promotionDiagnostics(wsId).stuck
        const id = makeFact({ tier: 0, confidence: 0.9, volatile: 1 })
        seedConfirmation(id, 'extraction', 0)
        seedConfirmation(id, 'tool', 1)
        seedConfirmation(id, 'human', 2)

        const after = repo.promotionDiagnostics(wsId).stuck
        assert.equal(after.total - before.total, 0, 'volatile facts are capped at T0 by design')
      })

      test('every stuck fact is attributed to exactly one bucket', () => {
        // The buckets are mutually exclusive by construction — each fact is
        // charged to the FIRST gate it fails — so the parts must sum to the
        // whole. A fact counted twice would overstate the problem.
        const { stuck } = repo.promotionDiagnostics(wsId)
        assert.equal(
          stuck.needsMoreDays + stuck.needsConfidence + stuck.awaitingSweep,
          stuck.total,
          'buckets must partition the stuck set'
        )
      })

      test('an unknown workspace returns a well-formed empty-ish result', () => {
        const result = repo.promotionDiagnostics('no-such-workspace-id')
        assert.equal(result.tierCounts.length, 4)
        assert.equal(
          result.stuck.needsMoreDays + result.stuck.needsConfidence + result.stuck.awaitingSweep,
          result.stuck.total
        )
      })
    })
  }
}
