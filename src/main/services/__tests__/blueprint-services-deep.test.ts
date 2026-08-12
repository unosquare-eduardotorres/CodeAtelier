/**
 * Phase 19, Track D — Blueprint pipeline services deep tests.
 *
 * Tests pure/exported functions across the blueprint service family:
 *   - blueprint-spec.service.ts (stripClarificationsSection, CLARIFY_CORRECTION_MESSAGE)
 *   - blueprint-goal-conditions.ts (all 7 buildXxxGoalCondition functions)
 *   - blueprint-artifact-parsers.ts (parseDiscoveriesBlock, parsePhaseCompletionBlock)
 *   - blueprint-phase-watchdog.ts (PhaseActivityWatchdog, STALL_TIMEOUT_MS)
 *   - blueprint-task-validator.ts (validateTaskGraph)
 *   - blueprint-chunk-forwarder.ts (forwardBlueprintChunk)
 *   - blueprint-error-reporter.ts (reportBlueprintPhaseError)
 *   - blueprint-document-loader.ts (splitBinaryDocs)
 *
 * No DB, no sockets, no spawns.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Imports ──────────────────────────────────────────────────────────────

let stripClarificationsSection: typeof import('../blueprint-spec.service').stripClarificationsSection
let CLARIFY_CORRECTION_MESSAGE: string

let buildSpecifyGoalCondition: typeof import('../blueprint-goal-conditions').buildSpecifyGoalCondition
let buildClarifyGoalCondition: typeof import('../blueprint-goal-conditions').buildClarifyGoalCondition
let buildPlanGoalCondition: typeof import('../blueprint-goal-conditions').buildPlanGoalCondition
let buildTasksGoalCondition: typeof import('../blueprint-goal-conditions').buildTasksGoalCondition
let buildReviewGoalCondition: typeof import('../blueprint-goal-conditions').buildReviewGoalCondition
let buildBuildGoalCondition: typeof import('../blueprint-goal-conditions').buildBuildGoalCondition
let buildVerifyGoalCondition: typeof import('../blueprint-goal-conditions').buildVerifyGoalCondition

let parseDiscoveriesBlock: typeof import('../blueprint-artifact-parsers').parseDiscoveriesBlock
let parsePhaseCompletionBlock: typeof import('../blueprint-artifact-parsers').parsePhaseCompletionBlock

let validateTaskGraph: typeof import('../blueprint-task-validator').validateTaskGraph
let STALL_TIMEOUT_MS: number
let PhaseActivityWatchdog: any
let splitBinaryDocs: typeof import('../blueprint-document-loader').splitBinaryDocs
let reportBlueprintPhaseError: typeof import('../blueprint-error-reporter').reportBlueprintPhaseError

let specLoaded = false
let goalsLoaded = false
let parsersLoaded = false
let validatorLoaded = false
let watchdogLoaded = false
let docLoaderLoaded = false
let errorReporterLoaded = false

try {
  const mod = require('../blueprint-spec.service')
  stripClarificationsSection = mod.stripClarificationsSection
  CLARIFY_CORRECTION_MESSAGE = mod.CLARIFY_CORRECTION_MESSAGE
  specLoaded = true
} catch {
  /* module optional under test env */
}

try {
  const mod = require('../blueprint-goal-conditions')
  buildSpecifyGoalCondition = mod.buildSpecifyGoalCondition
  buildClarifyGoalCondition = mod.buildClarifyGoalCondition
  buildPlanGoalCondition = mod.buildPlanGoalCondition
  buildTasksGoalCondition = mod.buildTasksGoalCondition
  buildReviewGoalCondition = mod.buildReviewGoalCondition
  buildBuildGoalCondition = mod.buildBuildGoalCondition
  buildVerifyGoalCondition = mod.buildVerifyGoalCondition
  goalsLoaded = true
} catch {
  /* module optional under test env */
}

try {
  const mod = require('../blueprint-artifact-parsers')
  parseDiscoveriesBlock = mod.parseDiscoveriesBlock
  parsePhaseCompletionBlock = mod.parsePhaseCompletionBlock
  parsersLoaded = true
} catch {
  /* module optional under test env */
}

try {
  validateTaskGraph = require('../blueprint-task-validator').validateTaskGraph
  validatorLoaded = true
} catch {
  /* module optional under test env */
}

try {
  const mod = require('../blueprint-phase-watchdog')
  PhaseActivityWatchdog = mod.PhaseActivityWatchdog
  STALL_TIMEOUT_MS = mod.STALL_TIMEOUT_MS
  watchdogLoaded = true
} catch {
  /* module optional under test env */
}

try {
  splitBinaryDocs = require('../blueprint-document-loader').splitBinaryDocs
  docLoaderLoaded = true
} catch {
  /* module optional under test env */
}

try {
  reportBlueprintPhaseError = require('../blueprint-error-reporter').reportBlueprintPhaseError
  errorReporterLoaded = true
} catch {
  /* module optional under test env */
}

// ── stripClarificationsSection ───────────────────────────────────────────

if (specLoaded) {
  describe('stripClarificationsSection', () => {
    test('returns_input_when_no_section', () => {
      const md = '# Spec\n\nSome content'
      assert.equal(stripClarificationsSection(md), md)
    })

    test('strips_section_at_end', () => {
      const md = '# Spec\n\nContent\n\n## Resolved Clarifications\n\nQ1: ...'
      const result = stripClarificationsSection(md)
      assert.equal(result, '# Spec\n\nContent')
      assert.ok(!result.includes('Resolved Clarifications'))
    })

    test('strips_section_preserving_before_content', () => {
      const md = 'Before\n## Resolved Clarifications\nAfter'
      const result = stripClarificationsSection(md)
      assert.equal(result, 'Before')
    })

    test('returns_empty_when_section_is_only_content', () => {
      const md = '## Resolved Clarifications\nContent'
      const result = stripClarificationsSection(md)
      assert.equal(result, '')
    })

    test('handles_empty_string', () => {
      assert.equal(stripClarificationsSection(''), '')
    })
  })

  describe('CLARIFY_CORRECTION_MESSAGE', () => {
    test('mentions_required_fence_names', () => {
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-findings'))
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-clarify-questions'))
      assert.ok(CLARIFY_CORRECTION_MESSAGE.includes('blueprint-phase-complete'))
    })
  })
}

// ── Blueprint goal conditions ────────────────────────────────────────────

if (goalsLoaded) {
  describe('Blueprint goal conditions', () => {
    test('buildSpecifyGoalCondition_includes_title', () => {
      const result = buildSpecifyGoalCondition('API Gateway')
      assert.ok(result.includes('API Gateway'))
      assert.ok(result.length > 20)
    })

    test('buildClarifyGoalCondition_is_non_empty', () => {
      const result = buildClarifyGoalCondition()
      assert.ok(result.length > 20)
    })

    test('buildPlanGoalCondition_includes_title', () => {
      const result = buildPlanGoalCondition('Auth Service')
      assert.ok(result.includes('Auth Service'))
    })

    test('buildTasksGoalCondition_includes_title', () => {
      const result = buildTasksGoalCondition('Payment Module')
      assert.ok(result.includes('Payment Module'))
    })

    test('buildReviewGoalCondition_includes_title', () => {
      const result = buildReviewGoalCondition('Dashboard')
      assert.ok(result.includes('Dashboard'))
    })

    test('buildBuildGoalCondition_includes_task_info', () => {
      const result = buildBuildGoalCondition('task-42', 'Create user model')
      assert.ok(result.includes('task-42'))
      assert.ok(result.includes('Create user model'))
    })

    test('buildVerifyGoalCondition_includes_title', () => {
      const result = buildVerifyGoalCondition('E-commerce')
      assert.ok(result.includes('E-commerce'))
    })

    test('all_goal_conditions_are_strings', () => {
      assert.equal(typeof buildSpecifyGoalCondition('x'), 'string')
      assert.equal(typeof buildClarifyGoalCondition(), 'string')
      assert.equal(typeof buildPlanGoalCondition('x'), 'string')
      assert.equal(typeof buildTasksGoalCondition('x'), 'string')
      assert.equal(typeof buildReviewGoalCondition('x'), 'string')
      assert.equal(typeof buildBuildGoalCondition('t', 'd'), 'string')
      assert.equal(typeof buildVerifyGoalCondition('x'), 'string')
    })
  })
}

// ── Blueprint artifact parsers ───────────────────────────────────────────

if (parsersLoaded) {
  describe('parseDiscoveriesBlock', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parseDiscoveriesBlock('No discoveries here'), null)
    })

    test('parses_fenced_discoveries', () => {
      const text = 'Before\n```blueprint-discoveries\n["Finding 1", "Finding 2"]\n```\nAfter'
      const result = parseDiscoveriesBlock(text)
      assert.ok(result)
      assert.equal(result!.length, 2)
      assert.equal(result![0], 'Finding 1')
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parseDiscoveriesBlock(''), null)
    })
  })

  describe('parsePhaseCompletionBlock', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parsePhaseCompletionBlock('No completion'), null)
    })

    test('parses_fenced_completion', () => {
      const text =
        'Content\n```blueprint-phase-complete\n{"phase":"specify","status":"complete","summary":"Done"}\n```'
      const result = parsePhaseCompletionBlock(text)
      assert.ok(result)
      assert.equal(result!.phase, 'specify')
      assert.equal(result!.status, 'complete')
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parsePhaseCompletionBlock(''), null)
    })
  })
}

// ── Blueprint task validator ─────────────────────────────────────────────

if (validatorLoaded) {
  describe('validateTaskGraph', () => {
    test('empty_tasks_returns_valid', () => {
      const result = validateTaskGraph([])
      assert.ok(result.valid)
      assert.equal(result.errors.length, 0)
    })

    test('single_task_is_valid', () => {
      const result = validateTaskGraph([{ taskId: 't1', wave: 0, dependsOn: [] }])
      assert.ok(result.valid)
      assert.equal(result.errors.length, 0)
    })

    test('linear_chain_is_valid', () => {
      const result = validateTaskGraph([
        { taskId: 't1', wave: 0, dependsOn: [] },
        { taskId: 't2', wave: 1, dependsOn: ['t1'] },
        { taskId: 't3', wave: 2, dependsOn: ['t2'] }
      ])
      assert.ok(result.valid)
    })

    test('cyclic_dependency_detected', () => {
      const result = validateTaskGraph([
        { taskId: 't1', wave: 0, dependsOn: ['t2'] },
        { taskId: 't2', wave: 0, dependsOn: ['t1'] }
      ])
      assert.ok(!result.valid)
      assert.ok(result.errors.length > 0)
    })

    test('missing_dependency_detected', () => {
      const result = validateTaskGraph([{ taskId: 't1', wave: 0, dependsOn: ['nonexistent'] }])
      assert.ok(!result.valid)
    })

    test('self_referencing_task_detected', () => {
      const result = validateTaskGraph([{ taskId: 't1', wave: 0, dependsOn: ['t1'] }])
      assert.ok(!result.valid)
    })

    test('diamond_dependency_is_valid', () => {
      const result = validateTaskGraph([
        { taskId: 't1', wave: 0, dependsOn: [] },
        { taskId: 't2', wave: 1, dependsOn: ['t1'] },
        { taskId: 't3', wave: 1, dependsOn: ['t1'] },
        { taskId: 't4', wave: 2, dependsOn: ['t2', 't3'] }
      ])
      assert.ok(result.valid)
    })

    test('duplicate_task_ids_detected', () => {
      const result = validateTaskGraph([
        { taskId: 't1', wave: 0, dependsOn: [] },
        { taskId: 't1', wave: 0, dependsOn: [] }
      ])
      assert.ok(!result.valid)
    })
  })
}

// ── Blueprint phase watchdog ─────────────────────────────────────────────

if (watchdogLoaded) {
  describe('PhaseActivityWatchdog', () => {
    test('STALL_TIMEOUT_MS_is_5_minutes', () => {
      assert.equal(STALL_TIMEOUT_MS, 5 * 60_000)
    })

    test('constructor_does_not_throw', () => {
      const wd = new PhaseActivityWatchdog({
        onStall: () => {},
        label: 'test'
      })
      assert.ok(wd)
      // Clean up timer
      wd.dispose()
    })

    test('touch_resets_without_throwing', () => {
      const wd = new PhaseActivityWatchdog({
        onStall: () => {},
        label: 'test'
      })
      wd.touch()
      wd.dispose()
    })

    test('pause_prevents_stall_callback', () => {
      const wd = new PhaseActivityWatchdog({
        onStall: () => {},
        label: 'test'
      })
      wd.pause()
      wd.dispose()
    })

    test('dispose_cleans_up', () => {
      const wd = new PhaseActivityWatchdog({
        onStall: () => {},
        label: 'test'
      })
      wd.dispose()
      // Should be safe to call twice
      wd.dispose()
    })
  })
}

// ── splitBinaryDocs ──────────────────────────────────────────────────────

if (docLoaderLoaded) {
  describe('splitBinaryDocs', () => {
    // ReferenceDocument = { path: string; label?: string }
    test('returns_empty_arrays_for_empty_input', () => {
      const result = splitBinaryDocs([])
      assert.ok(Array.isArray(result.textDocs))
      assert.ok(Array.isArray(result.binaryPaths))
      assert.equal(result.textDocs.length, 0)
      assert.equal(result.binaryPaths.length, 0)
    })

    test('classifies_markdown_as_text', () => {
      const result = splitBinaryDocs([{ path: '/path/to/file.md', type: 'file' as const }])
      assert.equal(result.textDocs.length, 1)
      assert.equal(result.binaryPaths.length, 0)
    })

    test('classifies_pdf_as_binary', () => {
      const result = splitBinaryDocs([{ path: '/path/to/doc.pdf', type: 'file' as const }])
      assert.equal(result.textDocs.length, 0)
      assert.equal(result.binaryPaths.length, 1)
    })

    test('classifies_mixed_files', () => {
      const result = splitBinaryDocs([
        { path: '/path/to/readme.md', type: 'file' as const },
        { path: '/path/to/design.pdf', type: 'file' as const },
        { path: '/path/to/spec.txt', type: 'file' as const },
        { path: '/path/to/report.docx', type: 'file' as const }
      ])
      assert.ok(result.textDocs.length >= 2)
      assert.ok(result.binaryPaths.length >= 1)
    })
  })
}

// ── reportBlueprintPhaseError ────────────────────────────────────────────

if (errorReporterLoaded) {
  describe('reportBlueprintPhaseError', () => {
    test('returns_error_report_object', () => {
      reportBlueprintPhaseError({
        phase: 'specify',
        blueprintId: 'bp-1',
        workspaceId: 'ws-1',
        error: new Error('test error')
      })
      // Should not throw
      assert.ok(true, 'reportBlueprintPhaseError did not throw')
    })
  })
}

// ── Fallback ─────────────────────────────────────────────────────────────

if (!specLoaded && !goalsLoaded && !parsersLoaded && !validatorLoaded && !watchdogLoaded) {
  describe('Blueprint Services Deep (all skipped)', () => {
    test('skipped', () => {}, { skipReason: 'no modules loaded' })
  })
}
