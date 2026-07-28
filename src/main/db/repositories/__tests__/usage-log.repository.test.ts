/**
 * Tests for UsageLogRepository (v102 usage_log table).
 * Skips gracefully if better-sqlite3 native module is incompatible.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('UsageLogRepository (skipped — native module unavailable)', () => {
    test('record() inserts a row', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { usageLogRepository } = require('../usage-log.repository')

  describe('UsageLogRepository', () => {
    test('record() round-trips a single entry', () => {
      const entry = usageLogRepository.record({
        feature: 'chat',
        agentType: 'specialist',
        model: 'claude-sonnet-4-6',
        workspaceId: wsId,
        conversationId: 'conv-1',
        sessionId: 'sess-1',
        turnNumber: 1,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        costCents: 7
      })
      assert.ok(entry.id)
      assert.equal(entry.feature, 'chat')
      assert.equal(entry.inputTokens, 100)
      assert.equal(entry.costCents, 7)
      assert.equal(entry.workspaceId, wsId)
    })

    test('getWorkspaceSummary aggregates totals + byFeature', () => {
      // Seed a couple more rows across features
      usageLogRepository.record({
        feature: 'grill',
        workspaceId: wsId,
        inputTokens: 200,
        outputTokens: 100,
        costCents: 14
      })
      usageLogRepository.record({
        feature: 'grill',
        workspaceId: wsId,
        inputTokens: 50,
        outputTokens: 25,
        costCents: 3
      })

      const summary = usageLogRepository.getWorkspaceSummary(wsId)
      // chat row: in100 out50 cr10 cc5 = 165 ; grill rows: 300 + 75 = 375 -> total 540
      assert.equal(summary.totalTokens, 540)
      assert.equal(summary.totalInput, 350)
      assert.equal(summary.totalOutput, 175)
      assert.equal(summary.totalCacheRead, 10)
      assert.equal(summary.totalCacheCreation, 5)
      assert.equal(summary.totalCostCents, 24)

      const grill = summary.byFeature.find((f: { feature: string }) => f.feature === 'grill')
      assert.ok(grill)
      assert.equal(grill.calls, 2)
      assert.equal(grill.tokens, 375)
      assert.equal(grill.costCents, 17)

      // byFeature is ordered by tokens desc — grill (375) before chat (165)
      assert.equal(summary.byFeature[0].feature, 'grill')
    })

    test('getGlobalSummary includes workspace-less rows', () => {
      usageLogRepository.record({
        feature: 'claude_md',
        workspaceId: null,
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 70
      })
      const global = usageLogRepository.getGlobalSummary()
      const claudeMd = global.byFeature.find((f: { feature: string }) => f.feature === 'claude_md')
      assert.ok(claudeMd, 'workspace-less rows appear in the global summary')
      assert.ok(global.totalTokens >= 540 + 1500)
    })

    test('getConversationSummary scopes to one conversation', () => {
      const summary = usageLogRepository.getConversationSummary('conv-1')
      assert.equal(summary.byFeature.length, 1)
      assert.equal(summary.byFeature[0].feature, 'chat')
      assert.equal(summary.totalTokens, 165)
    })

    test('pruneOlderThan keeps recent rows', () => {
      const deleted = usageLogRepository.pruneOlderThan(30)
      assert.equal(deleted, 0, 'freshly-inserted rows are not pruned')
    })
  })
}
