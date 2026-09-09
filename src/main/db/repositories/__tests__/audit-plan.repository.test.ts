/**
 * Tests for AuditPlanRepository — savePlan, getPlansForRun, JSON mapping.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('AuditPlanRepository (skipped — native module unavailable)', () => {
    test('savePlan()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { auditPlanRepository } = require('../audit-plan.repository')
  const { auditRepository } = require('../audit.repository')

  // Seed an audit run for FK ('light'/'deep' are the only modes the schema CHECK allows)
  const run = auditRepository.createRun(wsId, 'light', ['security'], ['typescript'])

  describe('AuditPlanRepository', () => {
    test('savePlan() returns mapped record', () => {
      const plan = {
        version: 1,
        title: 'Security Fix Plan',
        summary: 'Fix 3 SQL injection issues',
        items: [{ file: 'src/db.ts', action: 'Use parameterized queries', priority: 'high' }],
        risks: [{ description: 'Breaking DB layer', mitigation: 'Add tests' }],
        sourceFindingIds: ['finding-1', 'finding-2'],
        requirementDocument: 'Fix all SQL injection issues found in the audit'
      }

      const record = auditPlanRepository.savePlan(run.id, plan as any)
      assert.ok(record.id)
      assert.equal(record.auditRunId, run.id)
      assert.equal(record.title, 'Security Fix Plan')
      assert.equal(record.summary, 'Fix 3 SQL injection issues')
      assert.deepEqual(record.sourceFindingIds, ['finding-1', 'finding-2'])
      assert.ok(record.plan)
      assert.equal(record.plan.title, 'Security Fix Plan')
      assert.equal(record.plan.items.length, 1)
    })

    test('savePlan() handles plan with no sourceFindingIds', () => {
      const plan = {
        version: 1,
        title: 'Simple Plan',
        summary: 'A simple plan',
        items: [],
        risks: [],
        requirementDocument: ''
      }
      const record = auditPlanRepository.savePlan(run.id, plan as any)
      assert.deepEqual(record.sourceFindingIds, [])
    })

    test('getPlansForRun() returns plans newest first', () => {
      const run2 = auditRepository.createRun(wsId, 'deep', ['performance'], ['ts'])
      auditPlanRepository.savePlan(run2.id, {
        version: 1,
        title: 'First',
        summary: '',
        items: [],
        risks: [],
        sourceFindingIds: [],
        requirementDocument: ''
      } as any)
      auditPlanRepository.savePlan(run2.id, {
        version: 1,
        title: 'Second',
        summary: '',
        items: [],
        risks: [],
        sourceFindingIds: [],
        requirementDocument: ''
      } as any)

      // Backdate the first plan: created_at has 1-second granularity, so two
      // INSERTs in the same tick tie and the DESC order is unstable.
      db
        .prepare(
          `UPDATE audit_plans SET created_at = datetime('now', '-1 minute') WHERE title = 'First'`
        )
        .run()

      const plans = auditPlanRepository.getPlansForRun(run2.id)
      assert.equal(plans.length, 2)
      assert.equal(plans[0].title, 'Second') // newest first
    })

    test('getPlansForRun() returns empty for run with no plans', () => {
      const run3 = auditRepository.createRun(wsId, 'light', ['security'], ['ts'])
      const plans = auditPlanRepository.getPlansForRun(run3.id)
      assert.equal(plans.length, 0)
    })

    test('findById() round-trip', () => {
      const plan = auditPlanRepository.savePlan(run.id, {
        version: 1,
        title: 'Findable',
        summary: 'x',
        items: [],
        risks: [],
        sourceFindingIds: ['f1'],
        requirementDocument: ''
      } as any)
      const found = auditPlanRepository.findById(plan.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('audit_plans CHECK constraint rejects malformed plan_json', () => {
      // plan_json is `TEXT NOT NULL CHECK (json_valid(plan_json))` — the schema
      // now guarantees rows are parseable, which is what safeParseJSON's
      // malformed-input fallback used to defend against at read time.
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO audit_plans (audit_run_id, title, summary, plan_json, source_finding_ids)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(run.id, 'Bad JSON Plan', 'summary', 'NOT VALID JSON', '[]'),
        /CHECK constraint failed/
      )
    })

    test('mapRow() parses source_finding_ids from JSON', () => {
      db.prepare(
        `INSERT INTO audit_plans (audit_run_id, title, summary, plan_json, source_finding_ids)
         VALUES (?, ?, ?, ?, ?)`
      ).run(run.id, 'Finding IDs', 'x', '{}', '["a","b","c"]')

      const plans = auditPlanRepository.getPlansForRun(run.id)
      const plan = plans.find((p: any) => p.title === 'Finding IDs')
      assert.deepEqual(plan!.sourceFindingIds, ['a', 'b', 'c'])
    })
  })
}

// summaryAsync() calls process.exit() — only run it as the entry point; fired
// at module scope under a shared runner it terminates that run mid-list.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
