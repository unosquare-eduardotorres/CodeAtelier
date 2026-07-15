/**
 * Tests for usageTrackerService — the single recorder for all token consumption.
 * Verifies cost is computed via estimateCostCents and null workspace is handled.
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

let dbAvailable = false
let createTestDb: typeof import('../../db/test-helpers').createTestDb
let _setDatabaseForTesting: typeof import('../../db/index')._setDatabaseForTesting
let usageTrackerService: typeof import('../usage-tracker.service').usageTrackerService
let usageLogRepository: typeof import('../../db/repositories/usage-log.repository').usageLogRepository

try {
  createTestDb = require('../../db/test-helpers').createTestDb
  _setDatabaseForTesting = require('../../db/index')._setDatabaseForTesting
  usageTrackerService = require('../usage-tracker.service').usageTrackerService
  usageLogRepository = require('../../db/repositories/usage-log.repository').usageLogRepository
  const probe = createTestDb()
  probe.close()
  dbAvailable = true
} catch {
  dbAvailable = false
}

if (dbAvailable) {
  describe('usageTrackerService', () => {
    test('recordUsage computes cost via estimateCostCents (model pricing)', () => {
      _setDatabaseForTesting(createTestDb())
      // 1M input @ $3/1M for sonnet = $3.00 = 300 cents
      usageTrackerService.recordUsage({
        feature: 'chat',
        model: 'claude-sonnet-4-6',
        workspaceId: null,
        tokens: { input: 1_000_000, output: 0 }
      })
      const summary = usageLogRepository.getGlobalSummary()
      assert.equal(summary.totalCostCents, 300)
      assert.equal(summary.byFeature[0].feature, 'chat')
    })

    test('handles null workspace + missing token fields without throwing', () => {
      _setDatabaseForTesting(createTestDb())
      usageTrackerService.recordUsage({
        feature: 'condense',
        tokens: {} // all fields default to 0
      })
      const summary = usageLogRepository.getGlobalSummary()
      assert.equal(summary.totalTokens, 0)
      assert.equal(summary.totalCostCents, 0)
      assert.equal(summary.byFeature.length, 1)
      assert.equal(summary.byFeature[0].feature, 'condense')
    })
  })
}
