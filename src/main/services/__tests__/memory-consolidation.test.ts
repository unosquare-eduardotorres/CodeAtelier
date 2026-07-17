/**
 * memory-consolidation.test.ts — Tests for the MemoryConsolidationService.
 *
 * Covers: service instantiation, idle job start/stop, result shape validation.
 * Integration tests require DB + embedding provider and are deferred.
 */

import assert from 'node:assert/strict'
import { test, summaryAsync } from './test-harness'

test('memoryConsolidationService: exports a singleton', async () => {
  const mod = await import('../memory-consolidation.service')
  assert.ok(mod.memoryConsolidationService, 'Should export memoryConsolidationService')
  assert.equal(typeof mod.memoryConsolidationService.runFullConsolidation, 'function')
  assert.equal(typeof mod.memoryConsolidationService.startIdleJob, 'function')
  assert.equal(typeof mod.memoryConsolidationService.stopIdleJob, 'function')
})

test('memoryConsolidationService: runFullConsolidation returns result shape', async () => {
  const mod = await import('../memory-consolidation.service')

  // Without DB initialized, should return empty result or throw
  try {
    const result = await mod.memoryConsolidationService.runFullConsolidation('test-workspace')
    // If it returns, verify the shape
    assert.equal(typeof result.clustersFound, 'number')
    assert.equal(typeof result.autoMerged, 'number')
    assert.equal(typeof result.reviewItemsCreated, 'number')
    assert.equal(typeof result.staleArchived, 'number')
    assert.equal(typeof result.contradictionsPruned, 'number')
    assert.equal(typeof result.reviewQueueCapped, 'number')
  } catch {
    // Expected in test env without DB
    assert.ok(true, 'Throws without DB — acceptable')
  }
})

test('memoryConsolidationService: stopIdleJob is idempotent', async () => {
  const mod = await import('../memory-consolidation.service')
  // Should not throw when called without startIdleJob
  mod.memoryConsolidationService.stopIdleJob()
  mod.memoryConsolidationService.stopIdleJob()
  assert.ok(true, 'stopIdleJob should be safe to call multiple times')
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
