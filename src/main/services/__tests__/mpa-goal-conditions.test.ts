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
