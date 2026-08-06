/**
 * Tests for E2E test run and result repositories.
 * Validates CRUD operations, status updates, and aggregate queries.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { trySetupTestDb } from './db-test-helper'

const env = trySetupTestDb()

if (!env) {
  describe('E2E Test Repositories (skipped — native module unavailable)', () => {
    test('e2e_test_runs CRUD', () => {}, { skipReason: 'no DB' })
    test('e2e_test_results CRUD', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { wsId } = env
  const { e2eTestRunRepository } = require('../e2e-test-run.repository')
  const { e2eTestResultRepository } = require('../e2e-test-result.repository')

  describe('E2ETestRunRepository', () => {
    test('create returns a run with defaults', () => {
      const run = e2eTestRunRepository.create(wsId, 'test-model', 'omlx')
      assert.ok(run.id)
      assert.equal(run.workspaceId, wsId)
      assert.equal(run.status, 'running')
      assert.equal(run.modelId, 'test-model')
      assert.equal(run.backend, 'omlx')
      assert.equal(run.totalPassed, 0)
      assert.equal(run.totalFailed, 0)
    })

    test('findByWorkspace returns runs for workspace', () => {
      // Create two runs
      e2eTestRunRepository.create(wsId, 'model-1', 'omlx')
      e2eTestRunRepository.create(wsId, 'model-2', 'omlx')

      const runs = e2eTestRunRepository.findByWorkspace(wsId)
      assert.ok(runs.length >= 2)
      const models = runs.map((r: any) => r.modelId)
      assert.ok(models.includes('model-1'))
      assert.ok(models.includes('model-2'))
    })

    test('updateStatus sets status and totals', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      e2eTestRunRepository.updateStatus(run.id, 'completed', {
        passed: 5,
        failed: 2,
        skipped: 1,
        error: 0
      })

      const updated = e2eTestRunRepository.findById(run.id)
      assert.ok(updated)
      assert.equal(updated.status, 'completed')
      assert.equal(updated.totalPassed, 5)
      assert.equal(updated.totalFailed, 2)
      assert.equal(updated.totalSkipped, 1)
      assert.ok(updated.finishedAt)
    })

    test('findById returns undefined for nonexistent', () => {
      const run = e2eTestRunRepository.findById('nonexistent-id')
      assert.equal(run, undefined)
    })
  })

  describe('E2ETestResultRepository', () => {
    test('create returns a result with defaults', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      const result = e2eTestResultRepository.create(run.id, 'chat-core.basic-completion')
      assert.ok(result.id)
      assert.equal(result.runId, run.id)
      assert.equal(result.scenarioId, 'chat-core.basic-completion')
      assert.equal(result.status, 'queued')
      assert.equal(result.durationMs, null)
      assert.deepEqual(result.assertionResults, [])
      assert.deepEqual(result.transcriptJson, [])
    })

    test('createMany creates multiple results', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      const results = e2eTestResultRepository.createMany(run.id, ['sc-1', 'sc-2', 'sc-3'])
      assert.equal(results.length, 3)
      assert.equal(results[0].scenarioId, 'sc-1')
      assert.equal(results[2].scenarioId, 'sc-3')
    })

    test('findByRun returns all results for a run', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      e2eTestResultRepository.createMany(run.id, ['a', 'b'])

      const results = e2eTestResultRepository.findByRun(run.id)
      assert.equal(results.length, 2)
    })

    test('updateStatus with fields persists assertion results and transcript', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      const result = e2eTestResultRepository.create(run.id, 'test-scenario')

      e2eTestResultRepository.updateStatus(result.id, 'passed', {
        durationMs: 1500,
        assertionResults: [{ name: 'streamCompleted', passed: true }],
        transcriptJson: [{ role: 'user', type: 'text', content: 'Hello', timestamp: 1000 }],
        conversationId: 'conv-123'
      })

      const updated = e2eTestResultRepository.findById(result.id)
      assert.ok(updated)
      assert.equal(updated.status, 'passed')
      assert.equal(updated.durationMs, 1500)
      assert.equal(updated.assertionResults.length, 1)
      assert.equal(updated.assertionResults[0].name, 'streamCompleted')
      assert.equal(updated.transcriptJson.length, 1)
      assert.equal(updated.conversationId, 'conv-123')
    })

    test('findFailedByRun returns only failed/error results', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      const [r1, r2, r3] = e2eTestResultRepository.createMany(run.id, ['pass-1', 'fail-1', 'err-1'])
      e2eTestResultRepository.updateStatus(r1.id, 'passed')
      e2eTestResultRepository.updateStatus(r2.id, 'failed', { failureReason: 'bad' })
      e2eTestResultRepository.updateStatus(r3.id, 'error', { failureReason: 'crash' })

      const failed = e2eTestResultRepository.findFailedByRun(run.id)
      assert.equal(failed.length, 2)
      const scenarioIds = failed.map((r: { scenarioId: string }) => r.scenarioId)
      assert.ok(scenarioIds.includes('fail-1'))
      assert.ok(scenarioIds.includes('err-1'))
    })

    test('countByStatus returns correct tallies', () => {
      const run = e2eTestRunRepository.create(wsId, 'model', 'omlx')
      const results = e2eTestResultRepository.createMany(run.id, ['a', 'b', 'c', 'd'])
      e2eTestResultRepository.updateStatus(results[0].id, 'passed')
      e2eTestResultRepository.updateStatus(results[1].id, 'passed')
      e2eTestResultRepository.updateStatus(results[2].id, 'failed')
      // results[3] stays 'queued'

      const counts = e2eTestResultRepository.countByStatus(run.id)
      assert.equal(counts.passed, 2)
      assert.equal(counts.failed, 1)
      assert.equal(counts.queued, 1)
      assert.equal(counts.error, 0)
    })
  })
}
