/**
 * Tests for Plan status history + revision linking features.
 * Covers: recordStatusChange, getStatusHistory, updateStatus recording,
 * savePlan initial entry, revision auto-archive, getSupersedingPlan, getPreviousPlan,
 * and cascade delete behaviour.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('PlanStatusHistory (skipped — native module unavailable)', () => {
    test('recordStatusChange persists entry', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { planRepository } = require('../plan.repository')

  const makeStructuredPlan = (title: string) => ({
    title,
    summary: `Summary for ${title}`,
    phases: [{ name: 'Phase 1', files: [{ file: 'src/a.ts', action: 'modify' }] }],
    risks: [{ description: 'Risk 1' }],
    filesChanged: [{ file: 'src/a.ts', action: 'modify' }]
  })

  const saveFreshPlan = (source = 'chat', sourceId?: string) => {
    return planRepository.savePlan({
      workspaceId: wsId,
      source,
      sourceId: sourceId ?? `${source}-${Date.now()}-${Math.random()}`,
      title: `Plan ${Date.now()}`,
      summary: 'test',
      structuredPlan: makeStructuredPlan(`Plan ${Date.now()}`)
    })
  }

  describe('PlanStatusHistory', () => {
    // ── recordStatusChange ──

    test('recordStatusChange() persists a timeline entry', () => {
      const plan = saveFreshPlan()
      // savePlan already records null → saved, so add another
      planRepository.recordStatusChange(plan.id, 'saved', 'in_progress', 'user')

      const history = planRepository.getStatusHistory(plan.id)
      // At least 2 entries: initial + the one we just added
      assert.ok(history.length >= 2)
      const last = history[history.length - 1]
      assert.equal(last.fromStatus, 'saved')
      assert.equal(last.toStatus, 'in_progress')
      assert.equal(last.actor, 'user')
      assert.ok(last.id)
      assert.ok(last.changedAt)
    })

    // ── getStatusHistory ──

    test('getStatusHistory() returns entries in chronological order', () => {
      const plan = saveFreshPlan()
      planRepository.recordStatusChange(plan.id, 'saved', 'handed_off', 'user')
      planRepository.recordStatusChange(plan.id, 'handed_off', 'in_progress', 'user')

      const history = planRepository.getStatusHistory(plan.id)
      assert.ok(history.length >= 3)
      // Verify chronological ordering
      for (let i = 1; i < history.length; i++) {
        assert.ok(
          new Date(history[i].changedAt) >= new Date(history[i - 1].changedAt),
          `Entry ${i} should be >= entry ${i - 1}`
        )
      }
    })

    test('getStatusHistory() returns empty array for unknown plan', () => {
      const history = planRepository.getStatusHistory('nonexistent')
      assert.deepEqual(history, [])
    })

    // ── updateStatus records history ──

    test('updateStatus() automatically records a history entry', () => {
      const plan = saveFreshPlan()
      const historyBefore = planRepository.getStatusHistory(plan.id)
      const countBefore = historyBefore.length

      planRepository.updateStatus(plan.id, 'in_progress')

      const historyAfter = planRepository.getStatusHistory(plan.id)
      assert.equal(historyAfter.length, countBefore + 1)
      const newEntry = historyAfter[historyAfter.length - 1]
      assert.equal(newEntry.fromStatus, 'saved')
      assert.equal(newEntry.toStatus, 'in_progress')
      assert.equal(newEntry.actor, 'user')
    })

    // ── savePlan records initial status ──

    test('savePlan() records initial null → saved history entry', () => {
      const plan = saveFreshPlan()
      const history = planRepository.getStatusHistory(plan.id)
      assert.ok(history.length >= 1)
      const first = history[0]
      assert.equal(first.fromStatus, null)
      assert.equal(first.toStatus, 'saved')
      assert.equal(first.actor, 'system')
    })

    // ── Revision linking ──

    test('savePlan() auto-archives previous plan from same source and sets previous_plan_id', () => {
      const source = 'blueprint'
      const plan1 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `bp-rev-${Date.now()}-1`,
        title: 'Plan v1',
        summary: 'v1',
        structuredPlan: makeStructuredPlan('v1')
      })
      assert.equal(plan1.status, 'saved')

      // Save another plan from the same source — should auto-archive plan1
      const plan2 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `bp-rev-${Date.now()}-2`,
        title: 'Plan v2',
        summary: 'v2',
        structuredPlan: makeStructuredPlan('v2')
      })

      // plan1 should now be archived
      const plan1Updated = planRepository.getById(plan1.id)
      assert.ok(plan1Updated)
      assert.equal(plan1Updated.status, 'archived')

      // plan2 should have previous_plan_id pointing to plan1
      assert.equal(plan2.previousPlanId, plan1.id)
    })

    test('getSupersedingPlan() returns the plan that replaced this one', () => {
      const source = 'audit'
      const plan1 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `audit-sup-${Date.now()}-1`,
        title: 'Old Audit Plan',
        summary: 'old',
        structuredPlan: makeStructuredPlan('Old')
      })
      const plan2 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `audit-sup-${Date.now()}-2`,
        title: 'New Audit Plan',
        summary: 'new',
        structuredPlan: makeStructuredPlan('New')
      })

      const superseding = planRepository.getSupersedingPlan(plan1.id)
      assert.ok(superseding)
      assert.equal(superseding.id, plan2.id)
    })

    test('getPreviousPlan() follows the revision chain', () => {
      const source = 'council'
      const plan1 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `council-prev-${Date.now()}-1`,
        title: 'Council Plan v1',
        summary: 'v1',
        structuredPlan: makeStructuredPlan('v1')
      })
      const plan2 = planRepository.savePlan({
        workspaceId: wsId,
        source,
        sourceId: `council-prev-${Date.now()}-2`,
        title: 'Council Plan v2',
        summary: 'v2',
        structuredPlan: makeStructuredPlan('v2')
      })

      const prev = planRepository.getPreviousPlan(plan2.id)
      assert.ok(prev)
      assert.equal(prev.id, plan1.id)
    })

    test('getPreviousPlan() returns null when no previous plan', () => {
      // Use a unique source to avoid auto-archive linking to earlier test plans
      const plan = saveFreshPlan('grill', `no-prev-${Date.now()}`)
      const prev = planRepository.getPreviousPlan(plan.id)
      assert.equal(prev, null)
    })

    test('getSupersedingPlan() returns null when no superseding plan', () => {
      const plan = saveFreshPlan()
      const sup = planRepository.getSupersedingPlan(plan.id)
      assert.equal(sup, null)
    })

    // ── Cascade delete ──

    test('deleting a plan cascades to its status history', () => {
      const plan = saveFreshPlan()
      planRepository.updateStatus(plan.id, 'in_progress')
      const historyBefore = planRepository.getStatusHistory(plan.id)
      assert.ok(historyBefore.length >= 2)

      planRepository.deletePlan(plan.id)

      const historyAfter = planRepository.getStatusHistory(plan.id)
      assert.deepEqual(historyAfter, [])
    })
  })
}
