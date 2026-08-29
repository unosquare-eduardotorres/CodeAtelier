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

describe('parsePhaseCompletionBlock — verify-style fallback', () => {
  test('parses JSON block with overallStatus but no phase/status', () => {
    const text =
      'Verify report:\n```json\n{"overallStatus":"gaps_found","remediationTasks":[{"taskId":"R001","description":"Fix gap"}]}\n```\nDone'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result.phase, 'verify')
    assert.equal(result.status, 'complete')
    assert.equal((result as Record<string, unknown>).overallStatus, 'gaps_found')
  })

  test('handles nested objects in verify-style JSON', () => {
    const text =
      '```json\n{"overallStatus":"passed","artifacts":{"missing":0,"stub":0},"keyLinks":{"broken":0}}\n```'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal((result as Record<string, unknown>).overallStatus, 'passed')
    const artifacts = (result as Record<string, unknown>).artifacts as Record<string, number>
    assert.equal(artifacts.missing, 0)
  })

  test('primary tagged block takes priority over verify-style fallback', () => {
    const text =
      '```blueprint-phase-complete\n{"phase":"review","status":"complete"}\n```\n```json\n{"overallStatus":"passed"}\n```'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result.phase, 'review') // primary wins, not verify fallback
  })

  test('returns null for malformed JSON in verify-style block', () => {
    const text = '```json\n{"overallStatus": broken}\n```'
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

  // ── BP-TASKS-SILENT-EMPTY: the GLM truncation family ──

  /**
   * The exact observed failure: GLM emitted ~47K chars of narrative, then the
   * fenced JSON, and hit its output cap mid-block — the closing fence never
   * arrived, so the extraction regex could not match and the phase advanced
   * with zero tasks. BUILD then "completed" in 5 seconds with 0/0 tasks.
   */
  test('recovers tasks from an unclosed fence (output cap mid-block)', () => {
    const text =
      'Long thinking narrative before the block.\n\n```blueprint-tasks\n' +
      '{"totalTasks":2,"waves":[{"wave":1,"tasks":[{"taskId":"T001","description":"first"}]},{"wave":2,"tasks":[{"taskId":"T002","description":"second"}]}]}'
    // NOTE: no closing ``` — stream cut mid-block
    const result = parseBlueprintTasks(text)
    assert.ok(result, 'must recover from an unclosed fence')
    const waves = (result as any).waves as any[]
    assert.equal(waves.length, 2)
    assert.equal(waves[0].tasks[0].taskId, 'T001')
    assert.equal(waves[1].tasks[0].taskId, 'T002')
  })

  test('recovers complete waves when the JSON is cut mid-string inside a later wave', () => {
    const text =
      '```blueprint-tasks\n' +
      '{"totalTasks":3,"waves":[' +
      '{"wave":1,"tasks":[{"taskId":"T001","description":"a"},{"taskId":"T002","description":"b"}]},' +
      '{"wave":2,"tasks":[{"taskId":"T003","description":"cut off mid str'
    const result = parseBlueprintTasks(text)
    assert.ok(result, 'must recover the complete wave 1')
    const waves = (result as any).waves as any[]
    assert.equal(waves.length, 1)
    assert.equal(waves[0].tasks.length, 2)
    assert.equal(waves[0].tasks[1].taskId, 'T002')
  })

  test('repair truncates, never invents: a cut inside the FIRST wave yields null', () => {
    const text =
      '```blueprint-tasks\n{"totalTasks":2,"waves":[{"wave":1,"tasks":[{"taskId":"T001","descri'
    assert.equal(parseBlueprintTasks(text), null)
  })

  test('braces inside JSON strings do not fool the repair', () => {
    const text =
      '```blueprint-tasks\n' +
      '{"totalTasks":1,"waves":[{"wave":1,"tasks":[{"taskId":"T001","description":"uses } and { and \\" quotes"}]}'
    const result = parseBlueprintTasks(text)
    assert.ok(result)
    const waves = (result as any).waves as any[]
    assert.equal(waves[0].tasks[0].description, 'uses } and { and " quotes')
  })

  test('a complete block still parses without touching the repair path', () => {
    const text =
      '```blueprint-tasks\n{"totalTasks":1,"waves":[{"wave":1,"tasks":[{"taskId":"T001","description":"x"}]}]}\n```\ntrailing text'
    const result = parseBlueprintTasks(text)
    assert.ok(result)
    assert.equal((result as any).totalTasks, 1)
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

// ── Robustness / Stress Tests ──

describe('parsePhaseCompletionBlock — robustness', () => {
  test('handles large input without timeout (ReDoS guard)', () => {
    const large = '{"x": "' + 'y'.repeat(100_000) + '"}'
    const start = Date.now()
    const result = parsePhaseCompletionBlock(large)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 500, `Took ${elapsed}ms — suspected ReDoS`)
    assert.equal(result, null)
  })

  test('rejects input exceeding 500KB', () => {
    const huge = 'a'.repeat(600_000)
    assert.equal(parsePhaseCompletionBlock(huge), null)
  })

  test('extracts first JSON object, not cross-block match', () => {
    const text =
      '{"phase":"specify","status":"complete"}\nsome text\n{"phase":"verify","status":"complete"}'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result.phase, 'specify') // first block wins
  })

  test('handles nested JSON in verify-style fallback', () => {
    const text =
      '```json\n{"overallStatus":"gaps_found","artifacts":{"missing":2,"stub":1},"keyLinks":{"broken":1}}\n```'
    const result = parsePhaseCompletionBlock(text, 'verify')
    assert.ok(result)
    assert.equal((result as Record<string, unknown>).overallStatus, 'gaps_found')
    const artifacts = (result as Record<string, unknown>).artifacts as Record<string, number>
    assert.equal(artifacts.missing, 2)
    assert.equal(artifacts.stub, 1)
  })

  test('verify fallback does not activate for non-verify phases', () => {
    const text = '```json\n{"overallStatus":"passed"}\n```'
    assert.equal(parsePhaseCompletionBlock(text, 'build'), null)
    assert.equal(parsePhaseCompletionBlock(text, 'plan'), null)
    assert.equal(parsePhaseCompletionBlock(text, 'specify'), null)
  })

  test('stray LLM status cannot override pinned status in Fallback 2', () => {
    // LLM emits stray "status" key alongside overallStatus (but no "phase" key,
    // so Fallback 1 is skipped and Fallback 2 handles it)
    const text = '```json\n{"overallStatus":"gaps_found","status":"in_progress","findings":[]}\n```'
    const result = parsePhaseCompletionBlock(text, 'verify')
    assert.ok(result)
    assert.equal(result.status, 'complete', 'status must be pinned to complete')
    assert.equal(result.phase, 'verify', 'phase must be pinned to expectedPhase')
    assert.equal((result as Record<string, unknown>).overallStatus, 'gaps_found')
  })

  test('stray LLM phase cannot override pinned phase in Fallback 2', () => {
    // LLM emits stray "phase" key alongside overallStatus (but no "status" key,
    // so Fallback 1 is skipped and Fallback 2 handles it)
    const text = '```json\n{"overallStatus":"passed","phase":"build","findings":[]}\n```'
    const result = parsePhaseCompletionBlock(text, 'verify')
    assert.ok(result)
    assert.equal(result.phase, 'verify', 'phase must be pinned to expectedPhase')
    assert.equal(result.status, 'complete', 'status must be pinned to complete')
    assert.equal((result as Record<string, unknown>).overallStatus, 'passed')
  })

  test('Fallback 1 handles escaped quotes in strings', () => {
    const text = '{"phase":"specify","status":"complete","summary":"a \\"quoted\\" value"}'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result.phase, 'specify')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
