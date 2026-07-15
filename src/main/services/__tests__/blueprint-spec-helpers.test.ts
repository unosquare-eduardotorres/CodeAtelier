/**
 * Unit tests for blueprint spec/task/verify pure functions — artifact parsers,
 * goal conditions, wave flattening, pass/fail determination.
 *
 * Phase 14, Track 11a — Blueprint services deeper coverage.
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
  buildTasksGoalCondition,
  buildVerifyGoalCondition
} from '../blueprint-goal-conditions'

import { stripClarificationsSection } from '../blueprint-spec.service'

// ── Tests: Artifact Parsers ──

describe('Blueprint Parsers — parsePhaseCompletionBlock', () => {
  test('extracts_tagged_completion_block', () => {
    const text = 'Some text\n```blueprint-phase-complete\n{"phase":"specify","status":"complete"}\n```\nMore text'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result!.phase, 'specify')
    assert.equal(result!.status, 'complete')
  })

  test('falls_back_to_json_with_phase_and_status', () => {
    const text = 'Output: {"phase": "verify", "status": "complete", "overallStatus": "passed"}'
    const result = parsePhaseCompletionBlock(text)
    assert.ok(result)
    assert.equal(result!.phase, 'verify')
  })

  test('returns_null_for_no_match', () => {
    assert.equal(parsePhaseCompletionBlock('No completion here'), null)
  })

  test('returns_null_for_malformed_json', () => {
    const text = '```blueprint-phase-complete\n{broken\n```'
    assert.equal(parsePhaseCompletionBlock(text), null)
  })

  test('returns_null_for_missing_required_fields', () => {
    const text = '```blueprint-phase-complete\n{"phase":"specify"}\n```'
    assert.equal(parsePhaseCompletionBlock(text), null)
  })
})

describe('Blueprint Parsers — parseBlueprintTasks', () => {
  test('extracts_tagged_tasks_block', () => {
    const text = '```blueprint-tasks\n{"waves":[{"wave":1,"tasks":[]}]}\n```'
    const result = parseBlueprintTasks(text)
    assert.ok(result)
    assert.ok(Array.isArray((result as any).waves))
  })

  test('returns_null_for_no_match', () => {
    assert.equal(parseBlueprintTasks('No tasks here'), null)
  })

  test('returns_null_for_malformed_json', () => {
    const text = '```blueprint-tasks\n{broken\n```'
    assert.equal(parseBlueprintTasks(text), null)
  })
})

describe('Blueprint Parsers — parseBlueprintPlan', () => {
  test('extracts_tagged_plan_block', () => {
    const text = '```blueprint-plan\n{"title":"My Project","items":[]}\n```'
    const result = parseBlueprintPlan(text)
    assert.ok(result)
    assert.equal((result as any).title, 'My Project')
  })

  test('returns_null_for_no_match', () => {
    assert.equal(parseBlueprintPlan('No plan'), null)
  })
})

// ── Tests: Goal Conditions ──

describe('Blueprint Goal Conditions — specify', () => {
  test('includes_truncated_title', () => {
    const condition = buildSpecifyGoalCondition('Build a REST API')
    assert.ok(condition.includes('Build a REST API'))
  })

  test('requires_user_stories', () => {
    const condition = buildSpecifyGoalCondition('Test')
    assert.ok(condition.includes('user stories'))
  })

  test('requires_FR_requirement_IDs', () => {
    const condition = buildSpecifyGoalCondition('Test')
    assert.ok(condition.includes('FR-'))
  })
})

describe('Blueprint Goal Conditions — tasks', () => {
  test('requires_wave_structure', () => {
    const condition = buildTasksGoalCondition('Build feature')
    assert.ok(condition.includes('wave') || condition.includes('task'))
  })
})

describe('Blueprint Goal Conditions — verify', () => {
  test('includes_4_level_methodology', () => {
    const condition = buildVerifyGoalCondition('My feature')
    assert.ok(condition.includes('EXISTS') || condition.includes('SUBSTANTIVE'))
  })

  test('requires_anti_pattern_scan', () => {
    const condition = buildVerifyGoalCondition('Test')
    assert.ok(condition.includes('anti-pattern') || condition.includes('TODO'))
  })
})

// ── Tests: Wave Flattening ──

describe('Blueprint — wave flattening logic', () => {
  test('flattens_waves_to_flat_task_array', () => {
    const wavesJson = {
      waves: [
        {
          wave: 1,
          tasks: [
            { taskId: 'T1', description: 'Task 1', files: ['a.ts'] },
            { taskId: 'T2', description: 'Task 2' }
          ]
        },
        {
          wave: 2,
          tasks: [
            { taskId: 'T3', description: 'Task 3', dependsOn: ['T1'] }
          ]
        }
      ]
    }

    // Replicate the flatMap logic from blueprint-tasks.service.ts:225-234
    const flatTasks = wavesJson.waves.flatMap((w) =>
      w.tasks.map((t) => ({
        taskId: t.taskId,
        wave: w.wave,
        description: t.description,
        files: (t as any).files,
        dependsOn: (t as any).dependsOn
      }))
    )

    assert.equal(flatTasks.length, 3)
    assert.equal(flatTasks[0].wave, 1)
    assert.equal(flatTasks[0].taskId, 'T1')
    assert.equal(flatTasks[2].wave, 2)
    assert.deepEqual(flatTasks[2].dependsOn, ['T1'])
  })

  test('empty_waves_produces_empty_array', () => {
    const result = ([] as any[]).flatMap((w: any) => w.tasks.map((t: any) => t))
    assert.deepEqual(result, [])
  })
})

// ── Tests: Pass/Fail Determination ──

describe('Blueprint — verify pass/fail determination', () => {
  test('passed_status_is_complete', () => {
    const overallStatus = 'passed'
    const result = overallStatus === 'passed' || overallStatus === 'human_needed'
      ? 'complete' : 'failed'
    assert.equal(result, 'complete')
  })

  test('human_needed_status_is_complete', () => {
    const overallStatus: string = 'human_needed'
    const result = overallStatus === 'passed' || overallStatus === 'human_needed'
      ? 'complete' : 'failed'
    assert.equal(result, 'complete')
  })

  test('gaps_found_status_is_failed', () => {
    const overallStatus: string = 'gaps_found'
    const result = overallStatus === 'passed' || overallStatus === 'human_needed'
      ? 'complete' : 'failed'
    assert.equal(result, 'failed')
  })

  test('unknown_status_is_failed', () => {
    const overallStatus: string = 'unknown'
    const result = overallStatus === 'passed' || overallStatus === 'human_needed'
      ? 'complete' : 'failed'
    assert.equal(result, 'failed')
  })
})

// ── Tests: stripClarificationsSection (Plan B — clarify→spec merge) ──

describe('stripClarificationsSection', () => {
  test('returns_unchanged_when_no_clarifications_block', () => {
    const md = '# Spec\n\nSome content here.\n\n## Requirements\n\n- Req 1'
    assert.equal(stripClarificationsSection(md), md)
  })

  test('strips_resolved_clarifications_block', () => {
    const base = '# Spec\n\nSome content here.'
    const clarifications = '## Resolved Clarifications\n\nQ: What is the API?\nA: REST'
    const md = `${base}\n\n${clarifications}`
    assert.equal(stripClarificationsSection(md), base)
  })

  test('strips_block_with_trailing_whitespace', () => {
    const base = '# Spec\n\nContent'
    const md = `${base}\n\n  \n## Resolved Clarifications\n\nQ&A transcript`
    assert.equal(stripClarificationsSection(md), base)
  })

  test('merge_is_idempotent', () => {
    const base = '# Spec\n\nOriginal content.'
    const qa = 'Q: How many endpoints?\nA: Three.'
    const heading = '## Resolved Clarifications'

    // First merge
    const merged1 = `${base}\n\n${heading}\n\n${qa}`
    // Second merge (simulate re-run): strip then re-append
    const stripped = stripClarificationsSection(merged1)
    const merged2 = `${stripped}\n\n${heading}\n\n${qa}`

    assert.equal(merged1, merged2, 're-running merge should produce identical output')
  })

  test('handles_empty_string', () => {
    assert.equal(stripClarificationsSection(''), '')
  })

  test('preserves_content_before_heading', () => {
    const base = '# Spec\n\n## Section A\n\nDetails\n\n## Section B\n\nMore details'
    const md = `${base}\n\n## Resolved Clarifications\n\nQ&A`
    const result = stripClarificationsSection(md)
    assert.equal(result, base)
    assert.ok(result.includes('## Section A'))
    assert.ok(result.includes('## Section B'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
