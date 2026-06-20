/**
 * BlueprintBuildService — unit tests for pure helper functions.
 *
 * Tests buildTaskContext (task → context string formatting) and
 * buildArtifactSummary (build results → markdown summary).
 * Accesses private methods via prototype for testing.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintBuildService } from '../blueprint-build.service'

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
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
