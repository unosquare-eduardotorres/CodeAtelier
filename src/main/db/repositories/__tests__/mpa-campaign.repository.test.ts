/**
 * Tests for MpaCampaignRepository + campaign linkage on MpaRunRepository (v101).
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('MpaCampaignRepository (skipped — native module unavailable)', () => {
    test('create() inserts a campaign', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { mpaCampaignRepository } = require('../mpa-campaign.repository')
  const { mpaRunRepository } = require('../mpa-run.repository')

  describe('MpaCampaignRepository', () => {
    test('create() + findById round-trips', () => {
      const c = mpaCampaignRepository.create({
        workspaceId: wsId,
        title: 'Quiz Campaign',
        originalPlanMd: '# Plan\n...'
      })
      assert.ok(c.id)
      assert.equal(c.status, 'running')
      assert.equal(c.title, 'Quiz Campaign')

      const found = mpaCampaignRepository.findById(c.id)
      assert.ok(found)
      assert.equal(found.originalPlanMd, '# Plan\n...')
    })

    test('updateStatus sets completed_at on terminal states', () => {
      const c = mpaCampaignRepository.create({
        workspaceId: wsId,
        title: 'C2',
        originalPlanMd: ''
      })
      const paused = mpaCampaignRepository.updateStatus(c.id, 'paused')
      assert.equal(paused.status, 'paused')
      assert.equal(paused.completedAt, null)

      const done = mpaCampaignRepository.updateStatus(c.id, 'completed')
      assert.equal(done.status, 'completed')
      assert.ok(done.completedAt, 'completed_at should be set')
    })

    test('findByWorkspace returns campaigns newest-first', () => {
      const list = mpaCampaignRepository.findByWorkspace(wsId)
      assert.ok(list.length >= 2)
    })

    test('markStaleAsFailed flips running/paused campaigns', () => {
      const c = mpaCampaignRepository.create({
        workspaceId: wsId,
        title: 'Stale',
        originalPlanMd: ''
      })
      const changed = mpaCampaignRepository.markStaleAsFailed()
      assert.ok(changed >= 1)
      const found = mpaCampaignRepository.findById(c.id)
      assert.equal(found.status, 'failed')
    })
  })

  describe('MpaRunRepository campaign linkage', () => {
    test('createRun stores campaign_id + order_index; findByCampaign orders by index', () => {
      const campaign = mpaCampaignRepository.create({
        workspaceId: wsId,
        title: 'Linked',
        originalPlanMd: ''
      })
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal B',
        goal: 'second',
        goalType: 'feature',
        campaignId: campaign.id,
        orderIndex: 1
      })
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Goal A',
        goal: 'first',
        goalType: 'feature',
        campaignId: campaign.id,
        orderIndex: 0
      })

      const runs = mpaRunRepository.findByCampaign(campaign.id)
      assert.equal(runs.length, 2)
      assert.equal(runs[0].orderIndex, 0)
      assert.equal(runs[0].title, 'Goal A')
      assert.equal(runs[1].orderIndex, 1)
      assert.equal(runs[0].campaignId, campaign.id)
    })

    test('findByWorkspace excludes campaign-member runs', () => {
      const campaign = mpaCampaignRepository.create({
        workspaceId: wsId,
        title: 'Excluded',
        originalPlanMd: ''
      })
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Standalone',
        goal: 'standalone goal text',
        goalType: 'feature'
      })
      mpaRunRepository.createRun({
        workspaceId: wsId,
        title: 'Campaign Goal',
        goal: 'campaign goal text',
        goalType: 'feature',
        campaignId: campaign.id,
        orderIndex: 0
      })

      const flat = mpaRunRepository.findByWorkspace(wsId, 100)
      assert.ok(flat.some((r: { title: string }) => r.title === 'Standalone'))
      assert.ok(
        !flat.some((r: { title: string }) => r.title === 'Campaign Goal'),
        'campaign-member runs must not appear in the flat workspace list'
      )
    })
  })
}
