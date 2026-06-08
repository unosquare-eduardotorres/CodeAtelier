/**
 * DB-backed tests for campaign retry de-duplication + the campaign-start guard.
 *
 *  - mpaRunRepository.deleteByCampaignOrder supersedes the prior failed run for
 *    an order index (so a retry leaves one attempt per goal, not two) and
 *    cascades to the run's phases.
 *  - MpaCampaignService.start() rejects when a campaign is already running for
 *    the workspace.
 *
 * Uses in-memory SQLite (the MPA tables aren't in schema.sql, so they're created
 * here to mirror the migration DDL). All tests skip gracefully when the
 * better-sqlite3 native module / heavy service imports are unavailable.
 */
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'

let passed = 0
let failed = 0
let skipped = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${(err as Error).message}`)
    failed++
  }
}

function skip(name: string): void {
  console.log(`  ⊘ ${name} (skipped)`)
  skipped++
}

function describe(name: string, fn: () => void): void {
  console.log(`\n${name}`)
  fn()
}

// ── MPA table DDL (mirrors migrations 93 + 101; schema.sql omits MPA tables) ──

const MPA_DDL = `
  CREATE TABLE IF NOT EXISTS mpa_campaigns (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    original_plan_md TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS mpa_runs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    conversation_id TEXT,
    grill_session_id TEXT,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    goal_type TEXT NOT NULL DEFAULT 'feature',
    status TEXT NOT NULL DEFAULT 'running',
    current_phase TEXT,
    config_json TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    total_tokens INTEGER DEFAULT 0,
    campaign_id TEXT REFERENCES mpa_campaigns(id) ON DELETE CASCADE,
    order_index INTEGER
  );
  CREATE TABLE IF NOT EXISTS mpa_phases (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    run_id TEXT NOT NULL REFERENCES mpa_runs(id) ON DELETE CASCADE,
    phase_type TEXT NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'pending',
    agent_role TEXT NOT NULL,
    goal_condition TEXT,
    input_artifact_id TEXT,
    output_artifact_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    tokens_used INTEGER DEFAULT 0,
    stream_content TEXT DEFAULT ''
  );
`

// ── Try to load native deps + the repository — skip all if unavailable ──

let dbAvailable = false
let createTestDb: typeof import('../../db/test-helpers').createTestDb
let seedWorkspace: typeof import('../../db/test-helpers').seedWorkspace
let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
let mpaRunRepository: typeof import('../../db/repositories/mpa-run.repository').mpaRunRepository

try {
  const helpers = require('../../db/test-helpers')
  createTestDb = helpers.createTestDb
  seedWorkspace = helpers.seedWorkspace
  _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
  mpaRunRepository = require('../../db/repositories/mpa-run.repository').mpaRunRepository

  const testDb = createTestDb()
  testDb.close()
  dbAvailable = true
} catch (err) {
  console.log(
    `\n⚠ better-sqlite3 native module not compatible with current Node.js — MPA retry DB tests will be skipped.`
  )
  console.log(`  (${(err as Error).message.split('\n')[0]})`)
}

function setup(): { wsId: string; campaignId: string } {
  const db = createTestDb()
  db.exec(MPA_DDL)
  _setDatabaseForTesting(db)
  const wsId = seedWorkspace(db)
  const campaignId = 'camp-1'
  db.prepare(
    `INSERT INTO mpa_campaigns (id, workspace_id, title, original_plan_md, status)
     VALUES (?, ?, ?, ?, 'running')`
  ).run(campaignId, wsId, 'Campaign', '')
  return { wsId, campaignId }
}

describe('mpaRunRepository.deleteByCampaignOrder — retry de-duplication', () => {
  if (!dbAvailable) {
    skip('supersedes the prior run for an order index')
    skip('only deletes the targeted order index')
    skip('cascades to the deleted run’s phases')
    skip('retry leaves exactly one run per order index')
  } else {
    test('supersedes the prior run for an order index', () => {
      const { wsId, campaignId } = setup()
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 0',
        goal: 'g0',
        goalType: 'feature',
        campaignId,
        orderIndex: 0
      })
      assert.equal(mpaRunRepository.findByCampaign(campaignId).length, 1)

      const removed = mpaRunRepository.deleteByCampaignOrder(campaignId, 0)
      assert.equal(removed, 1)
      assert.equal(mpaRunRepository.findByCampaign(campaignId).length, 0)
    })

    test('only deletes the targeted order index', () => {
      const { wsId, campaignId } = setup()
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 0',
        goal: 'g0',
        goalType: 'feature',
        campaignId,
        orderIndex: 0
      })
      const keep = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 1',
        goal: 'g1',
        goalType: 'feature',
        campaignId,
        orderIndex: 1
      })

      mpaRunRepository.deleteByCampaignOrder(campaignId, 0)
      const remaining = mpaRunRepository.findByCampaign(campaignId)
      assert.equal(remaining.length, 1)
      assert.equal(remaining[0].id, keep.id)
      assert.equal(remaining[0].orderIndex, 1)
    })

    test('cascades to the deleted run’s phases', () => {
      const { wsId, campaignId } = setup()
      const run = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 0',
        goal: 'g0',
        goalType: 'feature',
        campaignId,
        orderIndex: 0
      })
      mpaRunRepository.createPhase({
        runId: run.id,
        phaseType: 'plan',
        iteration: 1,
        agentRole: 'planner'
      })
      assert.equal(mpaRunRepository.findPhasesByRun(run.id).length, 1)

      mpaRunRepository.deleteByCampaignOrder(campaignId, 0)
      assert.equal(mpaRunRepository.findPhasesByRun(run.id).length, 0)
    })

    test('retry leaves exactly one run per order index', () => {
      const { wsId, campaignId } = setup()
      // First (failed) attempt at order 0.
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 0',
        goal: 'g0',
        goalType: 'feature',
        campaignId,
        orderIndex: 0
      })
      // Retry: supersede then re-run the same order index.
      mpaRunRepository.deleteByCampaignOrder(campaignId, 0)
      const retry = mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal 0',
        goal: 'g0',
        goalType: 'feature',
        campaignId,
        orderIndex: 0
      })

      const runs = mpaRunRepository.findByCampaign(campaignId)
      assert.equal(runs.length, 1)
      assert.equal(runs[0].id, retry.id)
    })
  }
})

// ── Campaign-start guard (rejects when a campaign is already running) ──

let MpaCampaignService: typeof import('../mpa-campaign.service').MpaCampaignService | undefined
try {
  MpaCampaignService = require('../mpa-campaign.service').MpaCampaignService
} catch {
  // Heavy service import (agent SDK) unavailable in this environment — skip.
}

describe('MpaCampaignService.start — already-running guard', () => {
  if (!MpaCampaignService) {
    skip('rejects when a campaign is already running for the workspace')
    skip('isRunningForWorkspace is false for an unknown workspace')
  } else {
    test('rejects when a campaign is already running for the workspace', () => {
      const svc = new MpaCampaignService()
      // Inject an active campaign so start() short-circuits before any DB /
      // orchestration work (the guard runs first).
      ;(svc as unknown as { campaigns: Map<string, { status: string }> }).campaigns.set('ws-1', {
        status: 'running'
      })
      assert.equal(svc.isRunningForWorkspace('ws-1'), true)
      assert.throws(
        () =>
          svc.start({
            workspaceId: 'ws-1',
            workspacePath: '/tmp/ws',
            title: 'C',
            originalPlanMd: '',
            goals: [
              {
                id: 'g1',
                title: 'Goal 1',
                outcome: 'do it',
                successCriteria: [],
                goalType: 'feature',
                phases: ['plan', 'execute', 'verify']
              }
            ]
          }),
        /already running/i
      )
    })

    test('isRunningForWorkspace is false for an unknown workspace', () => {
      const svc = new MpaCampaignService()
      assert.equal(svc.isRunningForWorkspace('nope'), false)
    })
  }
})

// ── Summary ──

console.log(`\n${'─'.repeat(40)}`)
console.log(
  `mpa-campaign-retry: ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`
)
if (failed > 0) process.exit(1)
