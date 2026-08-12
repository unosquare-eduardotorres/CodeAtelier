/**
 * Tests for AuditPlanRepository — savePlan, getPlansForRun, JSON mapping.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
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

  // Seed an audit run for FK
  const run = auditRepository.createRun(wsId, 'full', ['security'], ['typescript'])

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
      const run2 = auditRepository.createRun(wsId, 'full', ['performance'], ['ts'])
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

      const plans = auditPlanRepository.getPlansForRun(run2.id)
      assert.equal(plans.length, 2)
      assert.equal(plans[0].title, 'Second') // newest first
    })

    test('getPlansForRun() returns empty for run with no plans', () => {
      const run3 = auditRepository.createRun(wsId, 'quick', ['security'], ['ts'])
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

    test('mapRow() parses plan_json with safeParseJSON fallback', () => {
      // Insert a row with bad plan JSON
      db.prepare(
        `INSERT INTO audit_plans (audit_run_id, title, summary, plan_json, source_finding_ids)
         VALUES (?, ?, ?, ?, ?)`
      ).run(run.id, 'Bad JSON Plan', 'summary', 'NOT VALID JSON', '[]')

      const plans = auditPlanRepository.getPlansForRun(run.id)
      const badPlan = plans.find((p: any) => p.title === 'Bad JSON Plan')
      assert.ok(badPlan)
      // safeParseJSON fallback creates a minimal plan
      assert.ok(badPlan.plan)
      assert.equal(badPlan.plan.title, 'Bad JSON Plan')
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
