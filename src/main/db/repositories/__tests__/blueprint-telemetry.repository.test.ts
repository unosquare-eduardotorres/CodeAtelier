/**
 * blueprint-telemetry.repository.test.ts — E11 attempt-level telemetry.
 *
 * The contract worth pinning is not CRUD, it is the two design decisions this
 * repository exists to hold:
 *
 *   - `record()` must NEVER throw. Telemetry observes the pipeline; a broken
 *     writer must not be able to fail the build it is describing.
 *   - `kind` must accept a value nobody has thought of yet, without a schema
 *     change. Migration 44's legacy is that a CHECK on a shared column costs a
 *     table rebuild forever after.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { attachTestDb, liveTestDb } from './db-test-helper'

const env = attachTestDb()

let blueprintTelemetryRepository: any
if (env) {
  blueprintTelemetryRepository =
    require('../blueprint-telemetry.repository').blueprintTelemetryRepository
}

if (!env) {
  describe('blueprint telemetry (skipped — no DB)', () => {
    test('record appends a row', () => {}, { skipReason: 'no DB' })
  })
} else {
  const bpId = (): string => `bp-${Math.random().toString(36).slice(2, 10)}`

  describe('blueprintTelemetryRepository', () => {
    test('record() round-trips every field, including parsed data', () => {
      const id = bpId()
      blueprintTelemetryRepository.record({
        blueprintId: id,
        kind: 'overload',
        phase: 'build',
        taskId: 'T001',
        attempt: 2,
        data: { delayMs: 60_000, retry: 1 }
      })

      const rows = blueprintTelemetryRepository.findByBlueprint(id)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].blueprintId, id)
      assert.equal(rows[0].kind, 'overload')
      assert.equal(rows[0].phase, 'build')
      assert.equal(rows[0].taskId, 'T001')
      assert.equal(rows[0].attempt, 2)
      assert.deepEqual(rows[0].data, { delayMs: 60_000, retry: 1 })
    })

    test('optional fields default to null, data to {}', () => {
      const id = bpId()
      blueprintTelemetryRepository.record({ blueprintId: id, kind: 'scheduler' })
      const [row] = blueprintTelemetryRepository.findByBlueprint(id)
      assert.equal(row.phase, null)
      assert.equal(row.taskId, null)
      assert.equal(row.attempt, null)
      assert.deepEqual(row.data, {})
    })

    test('findByBlueprint is scoped and ordered oldest-first', () => {
      const a = bpId()
      const b = bpId()
      blueprintTelemetryRepository.record({ blueprintId: a, kind: 'stall', taskId: 'T1' })
      blueprintTelemetryRepository.record({ blueprintId: a, kind: 'nudge', taskId: 'T2' })
      blueprintTelemetryRepository.record({ blueprintId: b, kind: 'stall', taskId: 'T3' })

      const rows = blueprintTelemetryRepository.findByBlueprint(a)
      assert.deepEqual(
        rows.map((r: any) => r.taskId),
        ['T1', 'T2'],
        'narrative order — created_at ties break on rowid, not insertion luck'
      )
    })

    test('countByKind aggregates per blueprint', () => {
      const id = bpId()
      blueprintTelemetryRepository.record({ blueprintId: id, kind: 'overload' })
      blueprintTelemetryRepository.record({ blueprintId: id, kind: 'overload' })
      blueprintTelemetryRepository.record({ blueprintId: id, kind: 'stop_loss' })

      assert.deepEqual(blueprintTelemetryRepository.countByKind(id), {
        overload: 2,
        stop_loss: 1
      })
    })

    // The reason this table has no CHECK on `kind`. If this ever fails, someone
    // has added one, and adding a telemetry kind now costs a table rebuild.
    test('an unknown kind is accepted without a schema change', () => {
      const id = bpId()
      blueprintTelemetryRepository.record({
        blueprintId: id,
        kind: 'a_kind_invented_next_year' as never
      })
      assert.equal(blueprintTelemetryRepository.findByBlueprint(id).length, 1)
    })

    // Telemetry observes the pipeline; it must not be able to break it.
    test('record() swallows failures instead of failing the build', () => {
      const original = blueprintTelemetryRepository.db
      blueprintTelemetryRepository.db = (): never => {
        throw new Error('database is locked')
      }
      try {
        assert.doesNotThrow(() =>
          blueprintTelemetryRepository.record({ blueprintId: bpId(), kind: 'escalation' })
        )
      } finally {
        blueprintTelemetryRepository.db = original
      }
    })

    test('pruneOlderThan deletes aged rows and keeps recent ones', () => {
      const id = bpId()
      blueprintTelemetryRepository.record({ blueprintId: id, kind: 'auto_retry' })
      // `liveTestDb()`, not the handle captured at import: several files call
      // `_setDatabaseForTesting` at import time, so the last one wins for the
      // whole run and a captured handle can point at a database no repository
      // reads any more. Seeding and asserting must hit the same one.
      liveTestDb()
        .prepare(
          `INSERT INTO blueprint_telemetry (blueprint_id, kind, created_at)
           VALUES (?, ?, datetime('now', '-90 days'))`
        )
        .run(id, 'auto_retry')

      assert.equal(blueprintTelemetryRepository.findByBlueprint(id).length, 2)
      const removed = blueprintTelemetryRepository.pruneOlderThan(30)
      assert.ok(removed >= 1)
      assert.equal(
        blueprintTelemetryRepository.findByBlueprint(id).length,
        1,
        'the recent row must survive'
      )
    })

    test('pruneOlderThan rejects nonsense rather than deleting everything', () => {
      assert.equal(blueprintTelemetryRepository.pruneOlderThan(-1), 0)
      assert.equal(blueprintTelemetryRepository.pruneOlderThan(NaN), 0)
    })
  })
}
