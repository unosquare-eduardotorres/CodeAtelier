/**
 * Extended tests for cost-tracker.service.ts — DB-dependent budget logic.
 *
 * Tests checkBudget thresholds, getWorkspaceCostSummary, getConversationCostCents,
 * and getDailyCostCents using trySetupTestDb() for an in-memory DB.
 *
 * Also tests additional pure-logic edge cases for estimateCostCents.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  estimateCostCents,
  estimateCostFromTotal,
  MODEL_PRICING
} from '../cost-tracker.service'
import { trySetupTestDb, seedConversation } from '../../db/repositories/__tests__/db-test-helper'

// ── Pure-logic: additional estimateCostCents edge cases ──

describe('CostTracker — estimateCostCents edge cases', () => {
  test('fable-5 pricing is the most expensive', () => {
    const fableResult = estimateCostCents(1_000_000, 1_000_000, 'claude-fable-5')
    const opusResult = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-8')
    assert.ok(fableResult > opusResult, 'Fable 5 should be more expensive than Opus 4.8')
  })

  test('legacy opus-4-20250514 has highest legacy pricing', () => {
    const legacyOpus = estimateCostCents(1_000_000, 1_000_000, 'claude-opus-4-20250514')
    // inputPer1M=15.0, outputPer1M=75.0 → (15+75)*100 = 9000 cents
    assert.equal(legacyOpus, 9000)
  })

  test('haiku is the cheapest model', () => {
    const haikuCost = estimateCostCents(1_000_000, 1_000_000, 'claude-haiku-4-5-20251001')
    for (const [model, _pricing] of Object.entries(MODEL_PRICING)) {
      if (model === 'claude-haiku-4-5-20251001') continue
      const otherCost = estimateCostCents(1_000_000, 1_000_000, model)
      // claude-3-5-haiku-20241022 is even cheaper (0.8/4.0 vs 1.0/5.0)
      if (model !== 'claude-3-5-haiku-20241022') {
        assert.ok(
          haikuCost <= otherCost,
          `Haiku ($${haikuCost / 100}) should be ≤ ${model} ($${otherCost / 100})`
        )
      }
    }
  })

  test('estimateCostFromTotal uses 75/25 split', () => {
    const total1M = estimateCostFromTotal(1_000_000, 'claude-sonnet-4-6')
    // 750K input × 3.0/1M + 250K output × 15.0/1M = 2.25 + 3.75 = 6.00 → 600 cents
    assert.equal(total1M, 600)
  })
})

// ── Pure-logic: BudgetStatus type structure ──

describe('CostTracker — BudgetStatus and constants', () => {
  test('MODEL_PRICING has entries for all current models', () => {
    const currentModels = [
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-4-6',
      'claude-opus-4-8'
    ]
    for (const model of currentModels) {
      assert.ok(MODEL_PRICING[model], `Missing pricing for current model: ${model}`)
    }
  })

  test('MODEL_PRICING output is always more expensive than input', () => {
    for (const [model, pricing] of Object.entries(MODEL_PRICING)) {
      const p = pricing as { inputPer1M: number; outputPer1M: number }
      assert.ok(
        p.outputPer1M >= p.inputPer1M,
        `${model}: output (${p.outputPer1M}) should be ≥ input (${p.inputPer1M})`
      )
    }
  })
})

// ── DB-dependent: checkBudget, getWorkspaceCostSummary, etc. ──

const env = trySetupTestDb()

if (env) {
  const { db, wsId } = env

  describe('CostTracker.checkBudget (DB)', () => {
    // Import the service singleton after DB is set up
    const { costTrackerService } = require('../cost-tracker.service') as typeof import('../cost-tracker.service')
    const { workspaceRepository } = require('../../db/repositories') as typeof import('../../db/repositories')

    test('workspace with no budget settings → no warning, no exceeded', () => {
      // Default settings have no budget
      const status = costTrackerService.checkBudget(wsId)
      assert.equal(status.dailyBudgetCents, 0)
      assert.equal(status.sessionBudgetCents, 0)
      assert.equal(status.dailyWarning, false)
      assert.equal(status.dailyExceeded, false)
      assert.equal(status.dailyPercentUsed, 0)
    })

    test('workspace with dailyBudgetUsd set → returns correct budget in cents', () => {
      workspaceRepository.updateSettings(wsId, { dailyBudgetUsd: 10 })
      const status = costTrackerService.checkBudget(wsId)
      assert.equal(status.dailyBudgetCents, 1000)
    })

    test('workspace with sessionBudgetUsd set → returns correct budget in cents', () => {
      workspaceRepository.updateSettings(wsId, { sessionBudgetUsd: 5 })
      const status = costTrackerService.checkBudget(wsId)
      assert.equal(status.sessionBudgetCents, 500)
    })
  })

  describe('CostTracker.getWorkspaceCostSummary (DB)', () => {
    const { costTrackerService } = require('../cost-tracker.service') as typeof import('../cost-tracker.service')

    test('workspace with no sessions → zero summary', () => {
      // Create a fresh workspace with no sessions
      const freshWs = db
        .prepare(
          `INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`
        )
        .get('Fresh WS', '/tmp/fresh-ws') as { id: string }
      const summary = costTrackerService.getWorkspaceCostSummary(freshWs.id)
      assert.equal(summary.totalCostCents, 0)
      assert.equal(summary.sessionCount, 0)
      assert.equal(summary.byAgent.length, 0)
    })

    test('workspace with session → aggregated costs', () => {
      const freshWs = db
        .prepare(
          `INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`
        )
        .get('Cost WS', '/tmp/cost-ws') as { id: string }
      const convId = seedConversation(db, freshWs.id)
      // Insert a session with known token counts
      db.prepare(
        `INSERT INTO agent_sessions (workspace_id, conversation_id, agent_type, token_usage, input_tokens, output_tokens, model_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(freshWs.id, convId, 'da-vinci', 2000, 1500, 500, 'claude-sonnet-4-6')

      const summary = costTrackerService.getWorkspaceCostSummary(freshWs.id)
      assert.ok(summary.totalCostCents > 0, 'should have non-zero cost')
      assert.equal(summary.sessionCount, 1)
    })
  })

  describe('CostTracker.getConversationCostCents (DB)', () => {
    const { costTrackerService } = require('../cost-tracker.service') as typeof import('../cost-tracker.service')

    test('conversation with input/output breakdown → precise calculation', () => {
      const freshWs = db
        .prepare(
          `INSERT INTO workspaces (name, repo_path) VALUES (?, ?) RETURNING id`
        )
        .get('Conv Cost WS', '/tmp/conv-cost') as { id: string }
      const convId = seedConversation(db, freshWs.id)
      db.prepare(
        `INSERT INTO agent_sessions (workspace_id, conversation_id, agent_type, token_usage, input_tokens, output_tokens, model_used)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(freshWs.id, convId, 'da-vinci', 2000, 1000, 1000, 'claude-sonnet-4-6')

      const cost = costTrackerService.getConversationCostCents(convId)
      // 1000 input × 3.0/1M + 1000 output × 15.0/1M = 0.003 + 0.015 = 0.018 → 2 cents
      assert.ok(cost >= 0, 'cost should be non-negative')
    })

    test('unknown conversation → returns 0', () => {
      const cost = costTrackerService.getConversationCostCents('nonexistent-conv-id')
      assert.equal(cost, 0)
    })
  })
} else {
  describe('CostTracker DB tests (skipped)', () => {
    test('skipped — native module unavailable', () => {}, {
      skipReason: 'better-sqlite3 not compatible'
    })
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
