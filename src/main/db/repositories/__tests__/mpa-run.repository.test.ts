/**
 * Tests for MpaRunRepository — CRUD for MPA runs and phases.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MpaRunRepository (skipped — native module unavailable)', () => {
    test('createRun() inserts MPA run', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { mpaRunRepository } = require('../mpa-run.repository')

  describe('MpaRunRepository', () => {
    // ── createRun ──

    test('createRun() inserts and returns MPA run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Feature Implementation',
        goal: 'Implement user auth',
        goalType: 'feature'
      })
      assert.ok(run.id)
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.title, 'Feature Implementation')
      assert.equal(run.goal, 'Implement user auth')
      assert.equal(run.goalType, 'feature')
      assert.equal(run.status, 'pending')
      assert.deepEqual(run.configJson, {})
    })

    test('createRun() accepts optional fields', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Full Run',
        goal: 'Full goal',
        goalType: 'bugfix',
        grillSessionId: 'grill-1',
        configJson: { maxRetries: 3 },
        campaignId: 'camp-1',
        orderIndex: 0
      })
      assert.equal(run.grillSessionId, 'grill-1')
      assert.deepEqual(run.configJson, { maxRetries: 3 })
      assert.equal(run.campaignId, 'camp-1')
      assert.equal(run.orderIndex, 0)
    })

    // ── findById ──

    test('findById() returns run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Find Test',
        goal: 'goal',
        goalType: 'feature'
      })
      const found = mpaRunRepository.findById(run.id)
      assert.ok(found)
      assert.equal(found.title, 'Find Test')
    })

    test('findById() returns undefined for unknown id', () => {
      assert.equal(mpaRunRepository.findById('nonexistent'), undefined)
    })

    // ── findByWorkspace ──

    test('findByWorkspace() returns non-campaign runs', () => {
      const freshWs = 'mpa-ws-test'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'MPA WS', '/tmp/mpa-ws')

      mpaRunRepository.createRun({
        workspaceId: freshWs,
        title: 'Standalone',
        goal: 'g',
        goalType: 'feature'
      })
      mpaRunRepository.createRun({
        workspaceId: freshWs,
        title: 'Campaign Run',
        goal: 'g',
        goalType: 'feature',
        campaignId: 'camp-x',
        orderIndex: 0
      })
      const runs = mpaRunRepository.findByWorkspace(freshWs)
      assert.ok(runs.length >= 1)
      assert.ok(runs.every((r: any) => r.campaignId === null))
    })

    // ── findByCampaign ──

    test('findByCampaign() returns runs ordered by orderIndex', () => {
      const campId = 'camp-order-test-' + Date.now()
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 2',
        goal: 'g',
        goalType: 'feature',
        campaignId: campId,
        orderIndex: 1
      })
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 1',
        goal: 'g',
        goalType: 'feature',
        campaignId: campId,
        orderIndex: 0
      })
      const runs = mpaRunRepository.findByCampaign(campId)
      assert.equal(runs.length, 2)
      assert.equal(runs[0].title, 'Goal 1')
    })

    // ── updateRun ──

    test('updateRun() modifies run status and fields', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Update Test',
        goal: 'g',
        goalType: 'feature'
      })
      const updated = mpaRunRepository.updateRun(run.id, {
        status: 'running',
        currentPhase: 'planning',
        conversationId: 'conv-1',
        totalTokens: 5000
      })
      assert.ok(updated)
      assert.equal(updated.status, 'running')
      assert.equal(updated.currentPhase, 'planning')
      assert.equal(updated.conversationId, 'conv-1')
      assert.equal(updated.totalTokens, 5000)
    })

    test('updateRun() with no updates returns existing run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'NoOp Update',
        goal: 'g',
        goalType: 'feature'
      })
      const result = mpaRunRepository.updateRun(run.id, {})
      assert.ok(result)
      assert.equal(result.title, 'NoOp Update')
    })

    // ── deleteByCampaignOrder ──

    test('deleteByCampaignOrder() removes runs for campaign+order', () => {
      const campId = 'camp-del-test-' + Date.now()
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'To Delete',
        goal: 'g',
        goalType: 'feature',
        campaignId: campId,
        orderIndex: 0
      })
      const deleted = mpaRunRepository.deleteByCampaignOrder(campId, 0)
      assert.equal(deleted, 1)
    })

    // ── Phase operations ──

    test('createPhase() inserts phase for run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Phase Host',
        goal: 'g',
        goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'plan',
        iteration: 1,
        agentRole: 'planner',
        goalCondition: 'Complete the plan'
      })
      assert.ok(phase.id)
      assert.equal(phase.runId, run.id)
      assert.equal(phase.phaseType, 'plan')
      assert.equal(phase.iteration, 1)
      assert.equal(phase.agentRole, 'planner')
      assert.equal(phase.goalCondition, 'Complete the plan')
      assert.equal(phase.status, 'pending')
    })

    test('findPhasesByRun() returns phases for run', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Phases Run',
        goal: 'g',
        goalType: 'feature'
      })
      mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'plan',
        iteration: 1,
        agentRole: 'planner'
      })
      mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'build',
        iteration: 1,
        agentRole: 'builder'
      })
      const phases = mpaRunRepository.findPhasesByRun(run.id)
      assert.equal(phases.length, 2)
    })

    test('updatePhase() modifies phase fields', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Phase Update',
        goal: 'g',
        goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'plan',
        iteration: 1,
        agentRole: 'planner'
      })
      const updated = mpaRunRepository.updatePhase(phase.id, {
        status: 'running',
        startedAt: new Date().toISOString(),
        tokensUsed: 1000,
        streamContent: 'Plan output...'
      })
      assert.ok(updated)
      assert.equal(updated.status, 'running')
      assert.equal(updated.tokensUsed, 1000)
    })

    test('updatePhase() with empty updates returns undefined', () => {
      assert.equal(mpaRunRepository.updatePhase('any-id', {}), undefined)
    })

    test('appendStreamContent() appends to phase stream', () => {
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Stream Append',
        goal: 'g',
        goalType: 'feature'
      })
      const phase = mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'build',
        iteration: 1,
        agentRole: 'builder'
      })
      mpaRunRepository.appendStreamContent(phase.id, 'First chunk. ')
      mpaRunRepository.appendStreamContent(phase.id, 'Second chunk.')
      const phases = mpaRunRepository.findPhasesByRun(run.id)
      const found = phases.find((p: any) => p.id === phase.id)
      assert.ok(found)
      assert.equal(found.streamContent, 'First chunk. Second chunk.')
    })

    // ── findResumable ──

    test('findResumable() returns latest failed/cancelled run', () => {
      const freshWs = 'mpa-resume-ws'
      env.db
        .prepare('INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)')
        .run(freshWs, 'Resume WS', '/tmp/resume-ws')

      const run = mpaRunRepository.createRun({
        workspaceId: freshWs,
        title: 'Failed Run',
        goal: 'g',
        goalType: 'feature'
      })
      mpaRunRepository.updateRun(run.id, { status: 'failed' })
      const resumable = mpaRunRepository.findResumable(freshWs)
      assert.ok(resumable)
      assert.equal(resumable.status, 'failed')
    })

    test('findResumable() returns null when no resumable runs', () => {
      assert.equal(mpaRunRepository.findResumable('no-resumable-ws'), null)
    })
  })
}
