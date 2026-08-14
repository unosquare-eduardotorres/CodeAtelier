/**
 * The "Build Now" kickoff must not be re-read as user intent.
 *
 * The bug: handleBuildNow switches the conversation to build mode, then sends a
 * hidden kickoff carrying the plan's task manifest. sendMessage's build → plan
 * auto-switch then ran on that machine-generated text; because the manifest is
 * long (>300 chars) and quotes the plan's own task titles, a title containing a
 * scope verb ("refactor", "migrate", "rewrite"…) scored 2 signals in
 * detectComplexTask and flipped the conversation straight back to plan mode.
 * Build Now silently undid itself — and only for plans whose task titles
 * happened to contain such a verb, which is why it looked intermittent.
 *
 * Run: tsx src/renderer/src/utils/__tests__/build-kickoff-mode-guard.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  detectComplexTask,
  detectPlanIntent,
  shouldAutoSwitchToPlan
} from '../plan-intent-detector'
import { renderTaskManifest } from '../../../../shared/plan-tasks'
import type { StructuredPlan } from '../../../../shared/types'

/** Mirrors handleBuildNow's kickoff construction (ChatExecutionPanel.tsx). */
function buildKickoff(manifest: string): string {
  return manifest
    ? [
        'Build the plan. Report phase progress using emit_phase_progress as you work through each phase.',
        '',
        'Task manifest — use these EXACT taskId values when reporting taskId/taskTitle/taskStatus ' +
          '(call with taskStatus "running" before starting a task and "complete"/"failed" after):',
        manifest
      ].join('\n')
    : 'Build the plan. Report phase progress using emit_phase_progress as you work through each phase.'
}

/** A plan whose task titles contain a scope verb — the case that reproduces. */
const PLAN_WITH_SCOPE_VERB: Pick<StructuredPlan, 'phases'> = {
  phases: [
    {
      id: 1,
      title: 'State model',
      complexity: 4,
      risk: 'low',
      description: 'Give the bar an explicit state',
      files: [
        { file: 'src/renderer/src/store/chat.store.ts', change: 'refactor the mode auto-switch' },
        { file: 'src/renderer/src/components/chat/BuildActionBar.tsx', change: 'render per state' }
      ]
    },
    {
      id: 2,
      title: 'Tests',
      complexity: 2,
      risk: 'low',
      description: 'Pin the behaviour',
      files: [{ file: 'src/renderer/src/utils/__tests__/guard.test.ts', change: 'cover the guard' }]
    }
  ]
}

/** Same shape, no scope verb anywhere — the case that always worked. */
const PLAN_WITHOUT_SCOPE_VERB: Pick<StructuredPlan, 'phases'> = {
  phases: [
    {
      id: 1,
      title: 'State model',
      complexity: 4,
      risk: 'low',
      description: 'Give the bar an explicit state',
      files: [
        { file: 'src/renderer/src/store/chat.store.ts', change: 'thread an option through' },
        { file: 'src/renderer/src/components/chat/BuildActionBar.tsx', change: 'render per state' }
      ]
    }
  ]
}

const kickoffWithVerb = buildKickoff(renderTaskManifest(PLAN_WITH_SCOPE_VERB))

describe('build kickoff hazard', () => {
  test('the kickoff never matches detectPlanIntent (all patterns are ^-anchored)', () => {
    assert.equal(detectPlanIntent(kickoffWithVerb), false)
  })

  test('HAZARD: a manifest quoting a scope verb DOES trigger detectComplexTask', () => {
    // Two signals: >300 chars (structural) + /refactor/ (scope action).
    assert.ok(kickoffWithVerb.length > 300, 'manifest kickoff should exceed the 300-char signal')
    assert.equal(detectComplexTask(kickoffWithVerb), true)
  })

  test('the same kickoff without a scope verb does not — hence the intermittency', () => {
    const clean = buildKickoff(renderTaskManifest(PLAN_WITHOUT_SCOPE_VERB))
    assert.equal(detectComplexTask(clean), false)
  })
})

describe('shouldAutoSwitchToPlan', () => {
  test('REGRESSION: the kickoff must NOT switch back to plan mode', () => {
    // Delete `skipModeDetection` from shouldAutoSwitchToPlan and this fails —
    // that is the whole point of the flag.
    assert.equal(
      shouldAutoSwitchToPlan({ mode: 'build', text: kickoffWithVerb, skipModeDetection: true }),
      false
    )
  })

  test('without the flag the same text would switch — proving the guard is load-bearing', () => {
    assert.equal(shouldAutoSwitchToPlan({ mode: 'build', text: kickoffWithVerb }), true)
  })

  test('genuine user intent in build mode still switches', () => {
    assert.equal(shouldAutoSwitchToPlan({ mode: 'build', text: 'investigate the auth flow' }), true)
  })

  test('plan mode never auto-switches', () => {
    assert.equal(shouldAutoSwitchToPlan({ mode: 'plan', text: 'investigate the auth flow' }), false)
    assert.equal(shouldAutoSwitchToPlan({ mode: undefined, text: 'investigate this' }), false)
  })

  test('ordinary build requests are left alone', () => {
    assert.equal(shouldAutoSwitchToPlan({ mode: 'build', text: 'fix the typo on line 42' }), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
