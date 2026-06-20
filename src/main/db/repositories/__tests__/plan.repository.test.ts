/**
 * Tests for PlanRepository — CRUD, filtering, retention, lifecycle transitions.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('PlanRepository (skipped — native module unavailable)', () => {
    test('savePlan()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { planRepository } = require('../plan.repository')

  const makeStructuredPlan = (overrides?: Record<string, unknown>) => ({
    title: 'Test Plan',
    summary: 'A test plan',
    phases: [{ name: 'Phase 1', files: [{ file: 'src/a.ts' }] }],
    risks: [{ description: 'risk 1' }],
    filesChanged: [{ file: 'src/b.ts' }],
    ...overrides
  })

  describe('PlanRepository', () => {
    test('savePlan() returns mapped record with derived counts', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'conv-1',
        title: 'My Plan',
        summary: 'Plan summary',
        structuredPlan: makeStructuredPlan()
      })
      assert.ok(plan.id)
      assert.equal(plan.workspaceId, wsId)
      assert.equal(plan.source, 'chat')
      assert.equal(plan.title, 'My Plan')
      assert.equal(plan.phaseCount, 1)
      assert.equal(plan.riskCount, 1)
      // filesChanged (src/b.ts) + phase files (src/a.ts) = 2
      assert.equal(plan.fileCount, 2)
      assert.equal(plan.status, 'draft')
    })

    test('getById() round-trip', () => {
      const saved = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'conv-get',
        title: 'Get By Id',
        summary: '',
        structuredPlan: makeStructuredPlan()
      })
      const found = planRepository.getById(saved.id)
      assert.ok(found)
      assert.equal(found.title, 'Get By Id')
      assert.ok(found.structuredPlan)
      assert.equal(found.structuredPlan.title, 'Test Plan')
    })

    test('getById() returns null for unknown id', () => {
      const found = planRepository.getById('nonexistent')
      assert.equal(found, null)
    })

    test('getForWorkspace() returns plans newest first', () => {
      const wsId2 = (() => {
        const row = db
          .prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Plan-Test', '/tmp/plan-test') as { id: string }
        return row.id
      })()

      planRepository.savePlan({
        workspaceId: wsId2, source: 'chat', sourceId: 'p1',
        title: 'First', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.savePlan({
        workspaceId: wsId2, source: 'grill', sourceId: 'p2',
        title: 'Second', summary: '', structuredPlan: makeStructuredPlan()
      })

      const plans = planRepository.getForWorkspace(wsId2)
      assert.equal(plans.length, 2)
      assert.equal(plans[0].title, 'Second')
    })

    test('getForWorkspace() filters by source', () => {
      const plans = planRepository.getForWorkspace(wsId, { source: 'chat' })
      assert.ok(plans.every((p: any) => p.source === 'chat'))
    })

    test('getForWorkspace() filters by search term', () => {
      planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'search-test',
        title: 'UniqueSearchTerm', summary: '', structuredPlan: makeStructuredPlan()
      })
      const plans = planRepository.getForWorkspace(wsId, { search: 'UniqueSearchTerm' })
      assert.ok(plans.length >= 1)
      assert.ok(plans.some((p: any) => p.title === 'UniqueSearchTerm'))
    })

    test('findBySource() deduplicates by source+sourceId', () => {
      planRepository.savePlan({
        workspaceId: wsId, source: 'audit', sourceId: 'dup-check',
        title: 'Dup', summary: '', structuredPlan: makeStructuredPlan()
      })
      const found = planRepository.findBySource('audit', 'dup-check')
      assert.ok(found)
      assert.equal(found.title, 'Dup')
    })

    test('updateStatus() changes status', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'status-test',
        title: 'Status', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.updateStatus(plan.id, 'in_progress')
      const updated = planRepository.getById(plan.id)
      assert.equal(updated!.status, 'in_progress')
    })

    test('markHandedOff() sets status + conversation link', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'grill', sourceId: 'handoff-test',
        title: 'Handoff', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.markHandedOff(plan.id, 'conv-123')
      const updated = planRepository.getById(plan.id)
      assert.equal(updated!.status, 'handed_off')
      assert.equal(updated!.linkedConversationId, 'conv-123')
    })

    test('markCompleted() sets status to completed', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'complete-test',
        title: 'Complete', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.markCompleted(plan.id)
      const updated = planRepository.getById(plan.id)
      assert.equal(updated!.status, 'completed')
    })

    test('deletePlan() removes plan and returns true', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'del-test',
        title: 'Delete', summary: '', structuredPlan: makeStructuredPlan()
      })
      const deleted = planRepository.deletePlan(plan.id)
      assert.equal(deleted, true)
      assert.equal(planRepository.getById(plan.id), null)
    })

    test('deletePlan() returns false for unknown id', () => {
      const deleted = planRepository.deletePlan('nonexistent')
      assert.equal(deleted, false)
    })

    test('enforceRetention() keeps only the newest N plans', () => {
      const wsId3 = (() => {
        const row = db
          .prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Retention', '/tmp/retention') as { id: string }
        return row.id
      })()

      for (let i = 0; i < 5; i++) {
        planRepository.savePlan({
          workspaceId: wsId3, source: 'chat', sourceId: `ret-${i}`,
          title: `Retention ${i}`, summary: '', structuredPlan: makeStructuredPlan()
        })
      }

      planRepository.enforceRetention(wsId3, 2)
      const remaining = planRepository.getForWorkspace(wsId3)
      assert.equal(remaining.length, 2)
    })

    test('deriveCounts handles plan with no phases/risks/files', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'empty-plan',
        title: 'Empty', summary: '', structuredPlan: { title: 'Empty', summary: '' }
      })
      assert.equal(plan.phaseCount, 0)
      assert.equal(plan.riskCount, 0)
      assert.equal(plan.fileCount, 0)
    })

    // ── Phase 9: Expanded coverage for untested methods ──

    test('markInProgress() sets status to in_progress', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'inprog-test',
        title: 'In Progress', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.markInProgress(plan.id)
      const updated = planRepository.getById(plan.id)
      assert.equal(updated!.status, 'in_progress')
    })

    test('markArchived() sets status to archived', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'chat', sourceId: 'archive-test',
        title: 'Archived', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.markArchived(plan.id)
      const updated = planRepository.getById(plan.id)
      assert.equal(updated!.status, 'archived')
    })

    test('getForWorkspace() filters by status', () => {
      const wsId4 = (() => {
        const row = db
          .prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-Status-Filter', '/tmp/status-filter') as { id: string }
        return row.id
      })()

      const p1 = planRepository.savePlan({
        workspaceId: wsId4, source: 'chat', sourceId: 'sf-1',
        title: 'Draft Plan', summary: '', structuredPlan: makeStructuredPlan()
      })
      const p2 = planRepository.savePlan({
        workspaceId: wsId4, source: 'chat', sourceId: 'sf-2',
        title: 'Completed Plan', summary: '', structuredPlan: makeStructuredPlan()
      })
      planRepository.markCompleted(p2.id)

      const drafts = planRepository.getForWorkspace(wsId4, { status: 'draft' })
      assert.ok(drafts.length >= 1)
      assert.ok(drafts.every((p: any) => p.status === 'draft'))
    })

    test('savePlan() with optional link fields', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId, source: 'council', sourceId: 'linked-test',
        title: 'Linked Plan', summary: '',
        structuredPlan: makeStructuredPlan(),
        linkedConversationId: 'conv-abc',
        linkedMpaRunId: 'mpa-123',
        linkedCouncilSessionId: 'council-456'
      })
      assert.equal(plan.linkedConversationId, 'conv-abc')
      assert.equal(plan.linkedMpaRunId, 'mpa-123')
      assert.equal(plan.linkedCouncilSessionId, 'council-456')
    })

    test('findBySource() returns null for non-existent source', () => {
      const found = planRepository.findBySource('chat', 'definitely-nonexistent-source-id')
      assert.equal(found, null)
    })
  })
}
