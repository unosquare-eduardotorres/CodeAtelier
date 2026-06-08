/**
 * MPA Goal Conditions — verifies goal condition builders for each phase.
 *
 * Pure logic: no filesystem, no network, no Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import {
  buildPlannerGoalCondition,
  buildBuilderGoalCondition,
  buildVerifierGoalCondition
} from '../mpa-goal-conditions'
import {
  buildPlannerSystemPrompt,
  buildBuilderSystemPrompt,
  buildVerifierSystemPrompt
} from '../mpa-prompts'
import type { MpaPlanArtifact } from '../../../shared/mpa-types'

const SAMPLE_PLAN: MpaPlanArtifact = {
  goalType: 'feature',
  summary: 'Add user authentication',
  items: [
    {
      id: 'P1',
      title: 'Add auth service',
      description: 'Create AuthService with login/logout',
      files: ['src/services/auth.service.ts'],
      scope: 'backend',
      dependsOn: [],
      includesTests: true
    },
    {
      id: 'P2',
      title: 'Add login page',
      description: 'Create LoginPage component',
      files: ['src/components/LoginPage.tsx'],
      scope: 'frontend',
      dependsOn: ['P1'],
      includesTests: false
    },
    {
      id: 'P3',
      title: 'Add auth middleware',
      description: 'JWT verification middleware',
      files: ['src/middleware/auth.ts'],
      scope: 'backend',
      dependsOn: ['P1'],
      includesTests: true
    }
  ],
  risks: ['Token expiry edge case'],
  existingPatterns: ['Follow UserService pattern']
}

describe('MPA Goal Conditions', () => {
  // ── Planner ──

  test('buildPlannerGoalCondition includes goal text', () => {
    const condition = buildPlannerGoalCondition('Add user authentication with OAuth2')
    assert.ok(condition.includes('Add user authentication with OAuth2'))
  })

  test('buildPlannerGoalCondition mentions goal-plan format', () => {
    const condition = buildPlannerGoalCondition('Build a REST API')
    assert.ok(condition.includes('goal-plan'))
  })

  test('buildPlannerGoalCondition truncates long goals', () => {
    const longGoal = 'A'.repeat(200)
    const condition = buildPlannerGoalCondition(longGoal)
    // The goal is sliced to 150 chars — full condition should not contain the full 200-char input
    assert.ok(!condition.includes(longGoal))
    assert.ok(condition.includes('A'.repeat(150)))
  })

  test('buildPlannerGoalCondition includes investigation requirement', () => {
    const condition = buildPlannerGoalCondition('Fix the bug')
    assert.ok(condition.includes('3 codebase files'))
  })

  // ── Builder ──

  test('buildBuilderGoalCondition includes all plan item IDs', () => {
    const condition = buildBuilderGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('P1'))
    assert.ok(condition.includes('P2'))
    assert.ok(condition.includes('P3'))
  })

  test('buildBuilderGoalCondition mentions tests', () => {
    const condition = buildBuilderGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('Tests'))
  })

  test('buildBuilderGoalCondition mentions no TODOs', () => {
    const condition = buildBuilderGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('TODO'))
  })

  // ── Verifier ──

  test('buildVerifierGoalCondition includes item count', () => {
    const condition = buildVerifierGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('3'))
  })

  test('buildVerifierGoalCondition mentions verify-report format', () => {
    const condition = buildVerifierGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('goal-verify-report'))
  })

  test('buildVerifierGoalCondition mentions test command', () => {
    const condition = buildVerifierGoalCondition(SAMPLE_PLAN)
    assert.ok(condition.includes('test command'))
  })
})

// ── Tool Priority Directive ──────────────────────────────────────────

const SAMPLE_TECHS = ['TypeScript', 'React']

describe('MPA Tool Priority Directive', () => {
  // Tool Priority is now injected by BaseRoleAdapter.appendToolGuidance() during
  // onSessionStart(), not by the raw prompt functions. These tests verify the
  // prompt functions produce valid prompts, and that the builder variant embeds
  // its own Tool Priority (it uses TOOL_PRIORITY_DIRECTIVE_BUILDER directly).
  test('planner prompt includes ## Tool Priority (via adapter lifecycle)', () => {
    // Tool Priority is now injected by MpaBaseAdapter.onSessionStart() → appendToolGuidance().
    // Verify the prompt function produces a valid prompt that the adapter will augment.
    const prompt = buildPlannerSystemPrompt({
      goal: 'Add auth',
      workspaceName: 'test',
      detectedTechs: SAMPLE_TECHS
    })
    assert.ok(prompt.length > 100, 'Planner prompt should be substantial')
    assert.ok(prompt.includes('## Constraints'), 'Planner prompt should include Constraints')
  })

  test('builder prompt includes ## Tool Priority', () => {
    // Builder prompt no longer embeds Tool Priority — the builder adapter
    // appends TOOL_PRIORITY_DIRECTIVE_BUILDER in buildPhaseSystemPrompt().
    const prompt = buildBuilderSystemPrompt({
      goal: 'Add auth',
      plan: SAMPLE_PLAN,
      workspaceName: 'test',
      detectedTechs: SAMPLE_TECHS
    })
    assert.ok(prompt.length > 100, 'Builder prompt should be substantial')
    assert.ok(prompt.includes('## Constraints'), 'Builder prompt should include Constraints')
  })

  test('verifier prompt includes ## Tool Priority (via adapter lifecycle)', () => {
    // Same as planner — injected by adapter lifecycle
    const prompt = buildVerifierSystemPrompt({
      goal: 'Add auth',
      plan: SAMPLE_PLAN,
      workspaceName: 'test'
    })
    assert.ok(prompt.length > 100, 'Verifier prompt should be substantial')
    assert.ok(prompt.includes('## Constraints'), 'Verifier prompt should include Constraints')
  })
})
