/**
 * Unit tests for plan-intent-detector.ts
 *
 * Tests both the existing detectPlanIntent and the new detectComplexTask
 * multi-signal complexity scorer.
 *
 * Run standalone:
 *   npx tsx src/renderer/src/utils/__tests__/plan-intent-detector.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { detectPlanIntent, detectComplexTask } from '../plan-intent-detector'

// ── detectPlanIntent (existing behavior) ────────────────────────────────

describe('detectPlanIntent', () => {
  test('matches investigation verbs at start of message', () => {
    assert.equal(detectPlanIntent('investigate the auth flow'), true)
    assert.equal(detectPlanIntent('check why builds are failing'), true)
    assert.equal(detectPlanIntent('review the database schema'), true)
    assert.equal(detectPlanIntent('audit the security headers'), true)
  })

  test('does not match action verbs mid-sentence', () => {
    assert.equal(detectPlanIntent('I want to investigate the auth flow'), false)
    assert.equal(detectPlanIntent('please review this PR'), false)
  })

  test('does not match build/action requests', () => {
    assert.equal(detectPlanIntent('fix the typo on line 42'), false)
    assert.equal(detectPlanIntent('add a button to the settings page'), false)
  })
})

// ── detectComplexTask (multi-signal scoring) ────────────────────────────

describe('detectComplexTask', () => {
  describe('triggers on 2+ signal categories', () => {
    const COMPLEX_MESSAGES = [
      'Cut the app off dead hosted Supabase and onto Azure',
      'Migrate the database from Postgres to MySQL',
      'Refactor the authentication module across the entire app',
      'Replace Redux with Zustand across the codebase',
      'Port the backend from Express to Fastify',
      'Move from Supabase to Azure and update the entire backend',
      'Set up CI/CD pipeline for the monorepo with Docker and Kubernetes',
      'Implement SSO with Azure AD for the entire frontend and backend'
    ]

    for (const msg of COMPLEX_MESSAGES) {
      test(`detects complex task: "${msg}"`, () => {
        assert.equal(detectComplexTask(msg), true)
      })
    }
  })

  describe('does not trigger for simple tasks', () => {
    const SIMPLE_MESSAGES = [
      'Fix the typo on line 42',
      'Add a button to the settings page',
      'Rename the variable to camelCase',
      'Update the README',
      'Delete the unused import',
      'Change the color to blue',
      'Run the tests',
      'Migrate' // single word — only 1 signal (scope), no structural/scale
    ]

    for (const msg of SIMPLE_MESSAGES) {
      test(`does not trigger for: "${msg}"`, () => {
        assert.equal(detectComplexTask(msg), false)
      })
    }
  })

  describe('signal category isolation', () => {
    test('scope action alone is not enough', () => {
      // "refactor" is a scope verb but no scale or structural signal
      assert.equal(detectComplexTask('refactor the login function'), false)
    })

    test('scale alone is not enough', () => {
      // "across the app" is scale but no scope action or structural signal
      assert.equal(detectComplexTask('update styles across the app'), false)
    })

    test('structural alone is not enough', () => {
      // "from X to Y" is structural but no scope action or scale
      assert.equal(detectComplexTask('change color from red to blue'), false)
    })

    test('scope + structural = triggers', () => {
      assert.equal(detectComplexTask('migrate from Postgres to MySQL'), true)
    })

    test('scope + scale = triggers', () => {
      assert.equal(detectComplexTask('refactor across the entire codebase'), true)
    })

    test('scale + structural = triggers', () => {
      // "entire backend" is scale, "from Express to Fastify" is structural (2 techs + from/to)
      assert.equal(detectComplexTask('rewrite the entire backend from Express to Fastify'), true)
    })
  })
})
