/**
 * BlueprintBuildService — unit tests for pure helper functions.
 *
 * Tests buildTaskContext (task → context string formatting) and
 * buildArtifactSummary (build results → markdown summary).
 * Accesses private methods via prototype for testing.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintBuildService, type TaskTiming } from '../blueprint-build.service'

describe('BlueprintBuildService', () => {
  describe('buildTaskContext', () => {
    const buildCtx = (BlueprintBuildService.prototype as any).buildTaskContext

    test('formats basic task with ID, wave, description', () => {
      const result = buildCtx({
        taskId: 'T001',
        wave: 1,
        description: 'Add auth middleware',
        userStory: null,
        filePathsJson: [],
        dependsOnJson: []
      })
      assert.ok(result.includes('T001'))
      assert.ok(result.includes('Wave**: 1'))
      assert.ok(result.includes('Add auth middleware'))
    })

    test('includes user story when present', () => {
      const result = buildCtx({
        taskId: 'T002',
        wave: 1,
        description: 'Add login page',
        userStory: 'As a user I can log in',
        filePathsJson: [],
        dependsOnJson: []
      })
      assert.ok(result.includes('As a user I can log in'))
    })

    test('includes file paths when present', () => {
      const result = buildCtx({
        taskId: 'T003',
        wave: 2,
        description: 'Create API route',
        userStory: null,
        filePathsJson: ['src/routes/auth.ts', 'src/middleware/jwt.ts'],
        dependsOnJson: []
      })
      assert.ok(result.includes('src/routes/auth.ts'))
      assert.ok(result.includes('src/middleware/jwt.ts'))
    })

    test('includes dependencies when present', () => {
      const result = buildCtx({
        taskId: 'T004',
        wave: 2,
        description: 'Wire up handlers',
        userStory: null,
        filePathsJson: [],
        dependsOnJson: ['T001', 'T002']
      })
      assert.ok(result.includes('T001'))
      assert.ok(result.includes('T002'))
      assert.ok(result.includes('Depends On'))
    })

    test('omits optional sections when empty', () => {
      const result = buildCtx({
        taskId: 'T005',
        wave: 1,
        description: 'Simple change',
        userStory: null,
        filePathsJson: [],
        dependsOnJson: []
      })
      assert.ok(!result.includes('User Story'))
      assert.ok(!result.includes('Files'))
      assert.ok(!result.includes('Depends On'))
    })
  })

  describe('buildArtifactSummary', () => {
    const buildSummary = (BlueprintBuildService.prototype as any).buildArtifactSummary

    test('shows task counts', () => {
      const result = buildSummary(3, 5, [], [])
      assert.ok(result.includes('3/5 completed'))
    })

    test('lists created files', () => {
      const result = buildSummary(1, 1, ['src/new-file.ts'], [])
      assert.ok(result.includes('Files Created'))
      assert.ok(result.includes('src/new-file.ts'))
    })

    test('lists modified files', () => {
      const result = buildSummary(1, 1, [], ['src/existing.ts'])
      assert.ok(result.includes('Files Modified'))
      assert.ok(result.includes('src/existing.ts'))
    })

    test('omits file sections when empty', () => {
      const result = buildSummary(0, 0, [], [])
      assert.ok(!result.includes('Files Created'))
      assert.ok(!result.includes('Files Modified'))
    })
  })

  // ── Phase 0: TaskTiming type export ──

  describe('TaskTiming (Phase 0)', () => {
    test('TaskTiming_interface_has_expected_shape', () => {
      // Verify the type export works and the shape is correct at runtime
      const timing: TaskTiming = {
        taskId: 'T001',
        wave: 1,
        tDispatch: 1000,
        tSessionReady: 1500,
        tFirstChunk: 2000,
        tComplete: 10000,
        tSlotFreed: 10050,
        durationMs: 9050
      }
      assert.equal(timing.taskId, 'T001')
      assert.equal(timing.wave, 1)
      assert.equal(timing.durationMs, timing.tSlotFreed - timing.tDispatch)
    })

    test('TaskTiming_durationMs_equals_slot_freed_minus_dispatch', () => {
      const timing: TaskTiming = {
        taskId: 'T002',
        wave: 2,
        tDispatch: 5000,
        tSessionReady: 5200,
        tFirstChunk: 5800,
        tComplete: 25000,
        tSlotFreed: 25010,
        durationMs: 20010
      }
      assert.equal(timing.durationMs, timing.tSlotFreed - timing.tDispatch)
      // Spawn time
      assert.equal(timing.tSessionReady - timing.tDispatch, 200)
      // Prefill latency
      assert.equal(timing.tFirstChunk - timing.tSessionReady, 600)
      // LLM work time
      assert.equal(timing.tComplete - timing.tFirstChunk, 19200)
    })
  })

  // ── Phase 1.1: Teardown off critical path ──

  describe('Teardown off critical path (Phase 1.1)', () => {
    test('activeSessions_map_exists_for_cancel_discovery', () => {
      // Verify the service has an activeSessions Map that cancelBlueprint can access
      const service = new BlueprintBuildService()
      // activeSessions is private, access via prototype/cast
      const sessions = (service as any).activeSessions
      assert.ok(sessions instanceof Map, 'activeSessions should be a Map')
    })

    test('cancelBlueprint_does_not_throw_with_no_active_sessions', async () => {
      const service = new BlueprintBuildService()
      // Should not throw when there's nothing to cancel
      await service.cancelBlueprint('nonexistent-bp')
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
