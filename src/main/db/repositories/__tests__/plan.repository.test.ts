/**
 * Tests for PlanRepository — CRUD, lifecycle, filtering, retention.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('PlanRepository (skipped — native module unavailable)', () => {
    test('savePlan() inserts plan', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { planRepository } = require('../plan.repository')

  const makeStructuredPlan = (title: string) => ({
    title,
    summary: 'Test plan summary',
    phases: [
      {
        name: 'Phase 1',
        files: [{ file: 'src/a.ts', action: 'modify' }]
      }
    ],
    risks: [{ description: 'Risk 1' }],
    filesChanged: [{ file: 'src/a.ts', action: 'modify' }]
  })

  describe('PlanRepository', () => {
    // ── savePlan ──

    test('savePlan() inserts and returns plan with derived counts', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'chat-' + Date.now(),
        title: 'Auth Plan',
        summary: 'Implement auth',
        structuredPlan: makeStructuredPlan('Auth Plan')
      })
      assert.ok(plan.id)
      assert.equal(plan.workspaceId, wsId)
      assert.equal(plan.source, 'chat')
      assert.equal(plan.title, 'Auth Plan')
      assert.equal(plan.status, 'draft')
      assert.equal(plan.phaseCount, 1)
      assert.ok(plan.riskCount >= 1)
      assert.ok(plan.fileCount >= 1)
    })

    test('savePlan() stores linked IDs', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'mpa',
        sourceId: 'mpa-' + Date.now(),
        title: 'Linked Plan',
        summary: 'summary',
        structuredPlan: makeStructuredPlan('Linked'),
        linkedConversationId: 'conv-1',
        linkedMpaRunId: 'mpa-1',
        linkedCouncilSessionId: 'council-1'
      })
      assert.equal(plan.linkedConversationId, 'conv-1')
      assert.equal(plan.linkedMpaRunId, 'mpa-1')
      assert.equal(plan.linkedCouncilSessionId, 'council-1')
    })

    // ── getById ──

    test('getById() returns plan', () => {
      const created = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'getby-' + Date.now(),
        title: 'GetById Test',
        summary: 's',
        structuredPlan: makeStructuredPlan('GetById')
      })
      const found = planRepository.getById(created.id)
      assert.ok(found)
      assert.equal(found.title, 'GetById Test')
    })

    test('getById() returns null for unknown id', () => {
      assert.equal(planRepository.getById('nonexistent'), null)
    })

    // ── getForWorkspace ──

    test('getForWorkspace() returns plans for workspace', () => {
      const plans = planRepository.getForWorkspace(wsId)
      assert.ok(plans.length >= 1)
    })

    test('getForWorkspace() filters by status', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'status-filter-' + Date.now(),
        title: 'Status Filter',
        summary: 's',
        structuredPlan: makeStructuredPlan('StatusFilter')
      })
      planRepository.updateStatus(plan.id, 'in_progress')
      const filtered = planRepository.getForWorkspace(wsId, { status: 'in_progress' })
      assert.ok(filtered.some((p: any) => p.id === plan.id))
    })

    test('getForWorkspace() filters by source', () => {
      planRepository.savePlan({
        workspaceId: wsId,
        source: 'grill',
        sourceId: 'grill-filter-' + Date.now(),
        title: 'Grill Plan',
        summary: 's',
        structuredPlan: makeStructuredPlan('GrillFilter')
      })
      const filtered = planRepository.getForWorkspace(wsId, { source: 'grill' })
      assert.ok(filtered.every((p: any) => p.source === 'grill'))
    })

    test('getForWorkspace() filters by search term', () => {
      planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'search-filter-' + Date.now(),
        title: 'UniqueSearchablePlan999',
        summary: 's',
        structuredPlan: makeStructuredPlan('SearchFilter')
      })
      const filtered = planRepository.getForWorkspace(wsId, { search: 'UniqueSearchablePlan999' })
      assert.ok(filtered.length >= 1)
    })

    // ── findBySource ──

    test('findBySource() returns plan by source+sourceId', () => {
      const sourceId = 'unique-source-' + Date.now()
      planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId,
        title: 'Source Test',
        summary: 's',
        structuredPlan: makeStructuredPlan('SourceTest')
      })
      const found = planRepository.findBySource('chat', sourceId)
      assert.ok(found)
      assert.equal(found.title, 'Source Test')
    })

    test('findBySource() returns null for unknown source', () => {
      assert.equal(planRepository.findBySource('chat', 'nonexistent'), null)
    })

    // ── updateStatus ──

    test('updateStatus() changes status', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'upd-status-' + Date.now(),
        title: 'Status',
        summary: 's',
        structuredPlan: makeStructuredPlan('Status')
      })
      planRepository.updateStatus(plan.id, 'in_progress')
      const found = planRepository.getById(plan.id)
      assert.ok(found)
      assert.equal(found.status, 'in_progress')
    })

    test('updateStatus() updates linked IDs', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'upd-links-' + Date.now(),
        title: 'Links',
        summary: 's',
        structuredPlan: makeStructuredPlan('Links')
      })
      planRepository.updateStatus(plan.id, 'handed_off', { conversationId: 'conv-linked' })
      const found = planRepository.getById(plan.id)
      assert.ok(found)
      assert.equal(found.linkedConversationId, 'conv-linked')
    })

    // ── Lifecycle convenience methods ──

    test('markHandedOff() sets status and links conversation', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'handoff-' + Date.now(),
        title: 'Handoff',
        summary: 's',
        structuredPlan: makeStructuredPlan('Handoff')
      })
      planRepository.markHandedOff(plan.id, 'conv-ho')
      const found = planRepository.getById(plan.id)
      assert.ok(found)
      assert.equal(found.status, 'handed_off')
      assert.equal(found.linkedConversationId, 'conv-ho')
    })

    test('markCompleted() sets status to completed', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'complete-' + Date.now(),
        title: 'Complete',
        summary: 's',
        structuredPlan: makeStructuredPlan('Complete')
      })
      planRepository.markCompleted(plan.id)
      const found = planRepository.getById(plan.id)
      assert.ok(found)
      assert.equal(found.status, 'completed')
    })

    test('markArchived() sets status to archived', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'archive-' + Date.now(),
        title: 'Archive',
        summary: 's',
        structuredPlan: makeStructuredPlan('Archive')
      })
      planRepository.markArchived(plan.id)
      const found = planRepository.getById(plan.id)
      assert.ok(found)
      assert.equal(found.status, 'archived')
    })

    // ── deletePlan ──

    test('deletePlan() removes plan', () => {
      const plan = planRepository.savePlan({
        workspaceId: wsId,
        source: 'chat',
        sourceId: 'delete-' + Date.now(),
        title: 'To Delete',
        summary: 's',
        structuredPlan: makeStructuredPlan('Delete')
      })
      const deleted = planRepository.deletePlan(plan.id)
      assert.equal(deleted, true)
      assert.equal(planRepository.getById(plan.id), null)
    })

    test('deletePlan() returns false for unknown id', () => {
      assert.equal(planRepository.deletePlan('nonexistent'), false)
    })
  })
}
