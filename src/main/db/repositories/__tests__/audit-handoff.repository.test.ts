/**
 * Tests for AuditHandoffRepository — the markers behind "already handed off".
 *
 * The ordering guarantee is the load-bearing part: the renderer keeps the FIRST
 * row it sees per finding, so `findByRun` returning the oldest handoff first
 * would make the badge name the wrong target. `created_at` only has second
 * resolution, which is coarser than a user clicking twice.
 *
 * Run: tsx src/main/db/repositories/__tests__/audit-handoff.repository.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { attachTestDb } from './db-test-helper'

const env = attachTestDb()

if (!env) {
  describe('AuditHandoffRepository (skipped — native module unavailable)', () => {
    test('record()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { auditHandoffRepository } = require('../audit-handoff.repository')
  const { auditRepository } = require('../audit.repository')

  describe('AuditHandoffRepository', () => {
    test('record() writes one mapped row per finding', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['typescript'])
      const rows = auditHandoffRepository.record({
        auditRunId: run.id,
        findingIds: ['f1', 'f2'],
        target: 'blueprint',
        refId: 'bp-1',
        refTitle: 'Audit remediation: 2 findings'
      })

      assert.equal(rows.length, 2)
      assert.deepEqual(
        rows.map((r: { findingId: string }) => r.findingId),
        ['f1', 'f2']
      )
      assert.equal(rows[0].auditRunId, run.id)
      assert.equal(rows[0].target, 'blueprint')
      assert.equal(rows[0].refId, 'bp-1')
      assert.equal(rows[0].refTitle, 'Audit remediation: 2 findings')
      assert.ok(rows[0].id)
      assert.ok(rows[0].createdAt)
    })

    test('record() defaults the reference columns to null', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      const [row] = auditHandoffRepository.record({
        auditRunId: run.id,
        findingIds: ['f1'],
        target: 'chat'
      })
      assert.equal(row.refId, null)
      assert.equal(row.refTitle, null)
    })

    test('record() with no findings writes nothing', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      assert.deepEqual(
        auditHandoffRepository.record({ auditRunId: run.id, findingIds: [], target: 'chat' }),
        []
      )
      assert.equal(auditHandoffRepository.findByRun(run.id).length, 0)
    })

    test('findByRun() returns the newest handoff first even within one second', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      auditHandoffRepository.record({
        auditRunId: run.id,
        findingIds: ['f1'],
        target: 'chat',
        refTitle: 'first'
      })
      auditHandoffRepository.record({
        auditRunId: run.id,
        findingIds: ['f1'],
        target: 'blueprint',
        refTitle: 'second'
      })

      const rows = auditHandoffRepository.findByRun(run.id)
      assert.equal(rows.length, 2, 'handing the same finding off twice keeps both rows')
      assert.equal(rows[0].refTitle, 'second')
      assert.equal(rows[0].target, 'blueprint')
    })

    test('findByRun() is scoped to its run', () => {
      const runA = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      const runB = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      auditHandoffRepository.record({ auditRunId: runA.id, findingIds: ['f1'], target: 'chat' })

      assert.equal(auditHandoffRepository.findByRun(runA.id).length, 1)
      assert.equal(auditHandoffRepository.findByRun(runB.id).length, 0)
    })

    test('an unknown target is rejected by the schema', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      assert.throws(() =>
        auditHandoffRepository.record({
          auditRunId: run.id,
          findingIds: ['f1'],
          target: 'goals' as never
        })
      )
    })

    test('markers die with the run they belong to', () => {
      const run = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      auditHandoffRepository.record({
        auditRunId: run.id,
        findingIds: ['f1', 'f2'],
        target: 'chat'
      })
      db.prepare('DELETE FROM audit_runs WHERE id = ?').run(run.id)
      assert.equal(auditHandoffRepository.findByRun(run.id).length, 0)
    })
  })
}
