/**
 * Blueprint Pure Functions — parser + goal condition tests.
 *
 * Covers:
 * - parsePhaseCompletionBlock: tagged block, fallback JSON, malformed, missing fields
 * - parseBlueprintTasks: tagged block, missing block
 * - All 7 goal condition builders (specify, clarify, plan, tasks, review, build, verify)
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  parsePhaseCompletionBlock,
  parseBlueprintTasks,
  parseBlueprintPlan
} from '../blueprint-artifact-parsers'
import {
  buildSpecifyGoalCondition,
  buildClarifyGoalCondition,
  buildPlanGoalCondition,
  buildTasksGoalCondition,
  buildReviewGoalCondition,
  buildBuildGoalCondition,
  buildVerifyGoalCondition
} from '../blueprint-goal-conditions'

// ── Artifact Parsers ──

describe('parsePhaseCompletionBlock', () => {
  test('parses valid blueprint-phase-complete block', () => {
    const text =
      'Some text\n```blueprint-phase-complete\n{"phase":"review","status":"complete","recommendation":"proceed"}\n```\nMore text'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result.phase, 'review')
    assert.equal(result.status, 'complete')
  })

  test('returns null for missing block', () => {
    assert.equal(parsePhaseCompletionBlock('Just plain text'), null)
  })

  test('returns null for malformed JSON', () => {
    const text = '```blueprint-phase-complete\n{not valid json}\n```'
    assert.equal(parsePhaseCompletionBlock(text), null)
  })

  test('returns null when phase or status missing', () => {
    const text = '```blueprint-phase-complete\n{"foo":"bar"}\n```'
    assert.equal(parsePhaseCompletionBlock(text), null)
  })
})

describe('parseBlueprintTasks', () => {
  test('parses valid blueprint-tasks block', () => {
    const text =
      '```blueprint-tasks\n{"waves":[{"wave":1,"tasks":[{"taskId":"T001","description":"test"}]}]}\n```'
    const result = parseBlueprintTasks(text)
    assert.ok(result)
    assert.ok(Array.isArray((result as any).waves))
  })

  test('returns null for missing block', () => {
    assert.equal(parseBlueprintTasks('no tasks here'), null)
  })
})

describe('parseBlueprintPlan', () => {
  test('parses valid blueprint-plan block', () => {
    const text = '```blueprint-plan\n{"items":[{"id":"P1","scope":"new file"}]}\n```'
    const result = parseBlueprintPlan(text)
    assert.ok(result)
    assert.ok(Array.isArray((result as any).items))
  })

  test('returns null for missing block', () => {
    assert.equal(parseBlueprintPlan('no plan here'), null)
  })
})

// ── Goal Conditions ──

describe('buildReviewGoalCondition', () => {
  test('includes title truncated to 150 chars', () => {
    const longTitle = 'A'.repeat(200)
    const result = buildReviewGoalCondition(longTitle)
    assert.ok(result.includes('A'.repeat(150)))
    assert.ok(!result.includes('A'.repeat(151)))
  })

  test('includes review-specific terms', () => {
    const result = buildReviewGoalCondition('Test Feature')
    assert.ok(result.includes('Cross-artifact review'))
    assert.ok(result.includes('phase: "review"'))
    assert.ok(result.includes('recommendation'))
    assert.ok(result.includes('findings'))
  })
})

describe('buildBuildGoalCondition', () => {
  test('includes taskId and description', () => {
    const result = buildBuildGoalCondition('T001', 'Implement auth middleware')
    assert.ok(result.includes('T001'))
    assert.ok(result.includes('Implement auth middleware'))
  })

  test('truncates description to 150 chars', () => {
    const longDesc = 'B'.repeat(200)
    const result = buildBuildGoalCondition('T002', longDesc)
    assert.ok(result.includes('B'.repeat(150)))
    assert.ok(!result.includes('B'.repeat(151)))
  })

  test('includes build-specific terms', () => {
    const result = buildBuildGoalCondition('T001', 'Test task')
    assert.ok(result.includes('phase: "build"'))
    assert.ok(result.includes('No placeholder'))
    assert.ok(result.includes('git add'))
  })
})

describe('all goal conditions return non-empty strings', () => {
  test('specify', () => assert.ok(buildSpecifyGoalCondition('T').length > 50))
  test('clarify', () => assert.ok(buildClarifyGoalCondition().length > 50))
  test('plan', () => assert.ok(buildPlanGoalCondition('T').length > 50))
  test('tasks', () => assert.ok(buildTasksGoalCondition('T').length > 50))
  test('review', () => assert.ok(buildReviewGoalCondition('T').length > 50))
  test('build', () => assert.ok(buildBuildGoalCondition('T001', 'Test').length > 50))
  test('verify', () => assert.ok(buildVerifyGoalCondition('T').length > 50))
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
