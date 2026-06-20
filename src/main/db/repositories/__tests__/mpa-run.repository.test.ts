/**
 * Tests for MpaRunRepository — run lifecycle, phases, campaign, stale detection.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MpaRunRepository (skipped — native module unavailable)', () => {
    test('createRun()', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { db, wsId } = env
  const { mpaRunRepository } = require('../mpa-run.repository')

  describe('MpaRunRepository', () => {
    // ── Run CRUD ──

    test('createRun() returns mapped model with defaults', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Test Run', goal: 'Add auth',
        goalType: 'feature'
      })
      assert.ok(run.id)
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.title, 'Test Run')
      assert.equal(run.goal, 'Add auth')
      assert.equal(run.goalType, 'feature')
      assert.equal(run.status, 'pending')
      assert.equal(run.totalTokens, 0)
      assert.deepEqual(run.configJson, {})
      assert.equal(run.campaignId, null)
    })

    test('createRun() accepts all optional fields', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Full Run', goal: 'Fix bugs',
        goalType: 'bugfix', grillSessionId: 'grill-1',
        configJson: { maxIterations: 3 },
        campaignId: 'campaign-1', orderIndex: 2
      })
      assert.equal(run.grillSessionId, 'grill-1')
      assert.deepEqual(run.configJson, { maxIterations: 3 })
      assert.equal(run.campaignId, 'campaign-1')
      assert.equal(run.orderIndex, 2)
    })

    test('findById() round-trip', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Findable', goal: 'X', goalType: 'feature'
      })
      const found = mpaRunRepository.findById(run.id)
      assert.ok(found)
      assert.equal(found.title, 'Findable')
    })

    test('findById() returns undefined for unknown', () => {
      assert.equal(mpaRunRepository.findById('nonexistent'), undefined)
    })

    test('findByWorkspace() excludes campaign runs', () => {
      const ws2 = (() => {
        const row = db.prepare(`INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`)
          .get('WS-MPA', '/tmp/mpa') as { id: string }
        return row.id
      })()
      mpaRunRepository.createRun({
        workspaceId: ws2, title: 'Standalone', goal: 'X', goalType: 'feature'
      })
      mpaRunRepository.createRun({
        workspaceId: ws2, title: 'Campaign', goal: 'Y', goalType: 'feature',
        campaignId: 'c1'
      })
      const runs = mpaRunRepository.findByWorkspace(ws2)
      assert.ok(runs.every((r: any) => r.campaignId === null))
    })

    test('updateRun() changes status and tokens', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Update', goal: 'X', goalType: 'feature'
      })
      const updated = mpaRunRepository.updateRun(run.id, {
        status: 'running', currentPhase: 'planning', totalTokens: 5000
      })
      assert.ok(updated)
      assert.equal(updated.status, 'running')
      assert.equal(updated.currentPhase, 'planning')
      assert.equal(updated.totalTokens, 5000)
    })

    test('updateRun() with empty updates returns existing', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'NoOp', goal: 'X', goalType: 'feature'
      })
      const result = mpaRunRepository.updateRun(run.id, {})
      assert.ok(result)
      assert.equal(result.title, 'NoOp')
    })

    test('mapRunRow() handles malformed config_json gracefully', () => {
      // Insert a run with bad JSON directly
      db.prepare(
        `INSERT INTO mpa_runs (id, workspace_id, title, goal, goal_type, config_json, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run('bad-json-run', wsId, 'Bad', 'X', 'feature', 'NOT JSON', 'pending')
      const found = mpaRunRepository.findById('bad-json-run')
      assert.ok(found)
      assert.deepEqual(found.configJson, {}) // fallback
    })

    // ── Campaign ──

    test('findByCampaign() returns runs in order_index order', () => {
      const cId = 'camp-order-test'
      mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Goal 2', goal: 'B', goalType: 'feature',
        campaignId: cId, orderIndex: 1
      })
      mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Goal 1', goal: 'A', goalType: 'feature',
        campaignId: cId, orderIndex: 0
      })
      const runs = mpaRunRepository.findByCampaign(cId)
      assert.equal(runs.length, 2)
      assert.equal(runs[0].orderIndex, 0)
      assert.equal(runs[1].orderIndex, 1)
    })

    test('deleteByCampaignOrder() removes run at specific order', () => {
      const cId = 'camp-del-test'
      mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Del', goal: 'X', goalType: 'feature',
        campaignId: cId, orderIndex: 0
      })
      const deleted = mpaRunRepository.deleteByCampaignOrder(cId, 0)
      assert.ok(deleted >= 1)
    })

    // ── Phase operations ──

    test('createPhase() returns mapped phase', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Phase Test', goal: 'X', goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id, phaseType: 'planning', iteration: 1,
        agentRole: 'planner', goalCondition: 'Plan must have 3+ phases'
      })
      assert.ok(phase.id)
      assert.equal(phase.runId, run.id)
      assert.equal(phase.phaseType, 'planning')
      assert.equal(phase.iteration, 1)
      assert.equal(phase.agentRole, 'planner')
      assert.equal(phase.goalCondition, 'Plan must have 3+ phases')
      assert.equal(phase.status, 'pending')
      assert.equal(phase.tokensUsed, 0)
    })

    test('findPhasesByRun() returns phases for run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Phases', goal: 'X', goalType: 'feature'
      })
      mpaRunRepository.createPhase({ runId: run.id, phaseType: 'planning', iteration: 1, agentRole: 'planner' })
      mpaRunRepository.createPhase({ runId: run.id, phaseType: 'building', iteration: 1, agentRole: 'builder' })

      const phases = mpaRunRepository.findPhasesByRun(run.id)
      assert.equal(phases.length, 2)
    })

    test('updatePhase() changes status and tokens', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Phase Update', goal: 'X', goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id, phaseType: 'planning', iteration: 1, agentRole: 'planner'
      })
      const updated = mpaRunRepository.updatePhase(phase.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        tokensUsed: 1000
      })
      assert.ok(updated)
      assert.equal(updated.status, 'running')
      assert.equal(updated.tokensUsed, 1000)
    })

    test('updatePhase() returns undefined with empty updates', () => {
      assert.equal(mpaRunRepository.updatePhase('some-id', {}), undefined)
    })

    test('appendStreamContent() appends to phase stream', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Stream', goal: 'X', goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id, phaseType: 'building', iteration: 1, agentRole: 'builder'
      })
      mpaRunRepository.appendStreamContent(phase.id, 'chunk 1')
      mpaRunRepository.appendStreamContent(phase.id, ' chunk 2')

      const phases = mpaRunRepository.findPhasesByRun(run.id)
      const found = phases.find((p: any) => p.id === phase.id)
      assert.ok(found!.streamContent.includes('chunk 1'))
      assert.ok(found!.streamContent.includes('chunk 2'))
    })

    // ── Stale detection ──

    test('markStaleAsFailed() marks running runs as failed', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Stale', goal: 'X', goalType: 'feature'
      })
      mpaRunRepository.updateRun(run.id, { status: 'running' })
      const count = mpaRunRepository.markStaleAsFailed()
      assert.ok(count >= 1)
      const found = mpaRunRepository.findById(run.id)
      assert.equal(found!.status, 'failed')
    })

    test('findResumable() finds failed/cancelled runs', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId, title: 'Resumable', goal: 'X', goalType: 'feature'
      })
      mpaRunRepository.updateRun(run.id, { status: 'failed' })
      const resumable = mpaRunRepository.findResumable(wsId)
      assert.ok(resumable)
      assert.ok(['failed', 'cancelled'].includes(resumable.status))
    })
  })
}
