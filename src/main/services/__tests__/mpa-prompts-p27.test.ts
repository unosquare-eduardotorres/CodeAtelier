/**
 * Phase 27 — mpa-prompts.ts pure function tests.
 *
 * All 3 exported functions (buildPlannerSystemPrompt, buildBuilderSystemPrompt,
 * buildVerifierSystemPrompt) are pure string assembly — no I/O, no side effects.
 */
import assert from 'node:assert/strict'
import { test, describe, summary } from './test-harness'
import {
  buildPlannerSystemPrompt,
  buildBuilderSystemPrompt,
  buildVerifierSystemPrompt
} from '../mpa-prompts'

// ── buildPlannerSystemPrompt ──

describe('buildPlannerSystemPrompt — planner prompt assembly', () => {
  test('includes goal and workspace name', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Build a REST API',
      workspaceName: 'my-project',
      detectedTechs: ['TypeScript', 'Express']
    })
    assert.ok(prompt.includes('Build a REST API'))
    assert.ok(prompt.includes('my-project'))
    assert.ok(prompt.includes('TypeScript, Express'))
  })

  test('includes detected techs or inspection fallback', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Add auth',
      workspaceName: 'app',
      detectedTechs: []
    })
    assert.ok(prompt.includes('Inspect project files to determine'))
  })

  test('includes grill decisions when provided', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Build feature',
      workspaceName: 'app',
      detectedTechs: ['React'],
      grillDecisions: [
        {
          header: 'Auth Strategy',
          selectedOption: 'JWT',
          reason: 'Stateless',
          questionId: 'q1',
          score: 8
        }
      ]
    })
    assert.ok(prompt.includes('Grill Decisions'))
    assert.ok(prompt.includes('Auth Strategy'))
    assert.ok(prompt.includes('JWT'))
    assert.ok(prompt.includes('Stateless'))
  })

  test('omits grill decisions section when empty', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Build feature',
      workspaceName: 'app',
      detectedTechs: ['React']
    })
    assert.ok(!prompt.includes('Grill Decisions'))
  })

  test('includes previous plan and user feedback for revisions', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Build API',
      workspaceName: 'app',
      detectedTechs: ['Node'],
      previousPlan: {
        contentJson: {
          goalType: 'feature',
          summary: 'Build REST API',
          items: [],
          risks: [],
          existingPatterns: []
        }
      },
      userFeedback: 'Add pagination to the endpoints'
    })
    assert.ok(prompt.includes('Previous Plan'))
    assert.ok(prompt.includes('Add pagination'))
    assert.ok(prompt.includes('Revise Based on Feedback'))
  })

  test('omits previous plan when feedback is not provided', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Build API',
      workspaceName: 'app',
      detectedTechs: ['Node'],
      previousPlan: {
        contentJson: {
          goalType: 'feature',
          summary: 'Build REST API',
          items: [],
          risks: [],
          existingPatterns: []
        }
      }
    })
    assert.ok(!prompt.includes('Previous Plan'))
  })

  test('includes read-only instruction', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Fix bug',
      workspaceName: 'app',
      detectedTechs: []
    })
    assert.ok(prompt.includes('Read-only'))
  })

  test('includes goal-plan JSON instruction', () => {
    const prompt = buildPlannerSystemPrompt({
      goal: 'Refactor',
      workspaceName: 'app',
      detectedTechs: []
    })
    assert.ok(prompt.includes('goal-plan'))
  })
})

// ── buildBuilderSystemPrompt ──

describe('buildBuilderSystemPrompt — builder prompt assembly', () => {
  const basePlan = {
    goalType: 'feature' as const,
    summary: 'Add auth',
    items: [
      {
        id: 'P1',
        title: 'Create auth middleware',
        description: 'JWT validation middleware',
        files: ['src/middleware/auth.ts'],
        scope: 'backend' as const,
        dependsOn: [],
        includesTests: true
      },
      {
        id: 'P2',
        title: 'Add login endpoint',
        description: 'POST /api/login',
        files: ['src/routes/auth.ts'],
        scope: 'backend' as const,
        dependsOn: ['P1'],
        includesTests: false
      }
    ],
    risks: [],
    existingPatterns: ['Express middleware pattern', 'Jest for tests']
  }

  test('includes goal and plan items', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Add JWT auth',
      plan: basePlan,
      workspaceName: 'my-api',
      detectedTechs: ['TypeScript', 'Express']
    })
    assert.ok(prompt.includes('Add JWT auth'))
    assert.ok(prompt.includes('P1: Create auth middleware'))
    assert.ok(prompt.includes('P2: Add login endpoint'))
  })

  test('marks items with includesTests', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Add auth',
      plan: basePlan,
      workspaceName: 'app',
      detectedTechs: ['TS']
    })
    assert.ok(prompt.includes('(includes tests)'))
  })

  test('includes existing patterns', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Add auth',
      plan: basePlan,
      workspaceName: 'app',
      detectedTechs: ['TS']
    })
    assert.ok(prompt.includes('Express middleware pattern'))
    assert.ok(prompt.includes('Jest for tests'))
  })

  test('handles empty existingPatterns', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Add auth',
      plan: { ...basePlan, existingPatterns: undefined },
      workspaceName: 'app',
      detectedTechs: ['TS']
    })
    assert.ok(prompt.includes('None noted'))
  })

  test('includes verifier feedback when provided', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Fix bugs',
      plan: basePlan,
      workspaceName: 'app',
      detectedTechs: ['TS'],
      verifierFeedback: {
        allComplete: false,
        totalItems: 2,
        implemented: 1,
        partial: 1,
        missing: 0,
        issues: [{ planItemId: 'P2', status: 'partial', detail: 'Missing error handling' }],
        crossCutting: {
          frontendBackendConnected: true,
          backendDatabaseConnected: false,
          routesRegistered: true,
          testsPass: false
        },
        testOutput: 'FAIL'
      }
    })
    assert.ok(prompt.includes('Verifier Issues'))
    assert.ok(prompt.includes('P2'))
    assert.ok(prompt.includes('Missing error handling'))
  })

  test('omits verifier section when no feedback', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app',
      detectedTechs: ['TS']
    })
    assert.ok(!prompt.includes('Verifier Issues'))
  })

  test('includes implementation instructions', () => {
    const prompt = buildBuilderSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app',
      detectedTechs: ['TS']
    })
    assert.ok(prompt.includes('Implement every plan item'))
    assert.ok(prompt.includes('No TODOs or stubs'))
  })
})

// ── buildVerifierSystemPrompt ──

describe('buildVerifierSystemPrompt — verifier prompt assembly', () => {
  const basePlan = {
    goalType: 'feature' as const,
    summary: 'Add auth',
    items: [
      {
        id: 'P1',
        title: 'Auth middleware',
        description: 'JWT middleware',
        files: ['src/auth.ts', 'src/jwt.ts'],
        scope: 'backend' as const,
        dependsOn: [],
        includesTests: true
      }
    ],
    risks: [],
    existingPatterns: []
  }

  test('includes goal and plan items with file listing', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Add auth',
      plan: basePlan,
      workspaceName: 'app'
    })
    assert.ok(prompt.includes('Add auth'))
    assert.ok(prompt.includes('P1: Auth middleware'))
    assert.ok(prompt.includes('src/auth.ts, src/jwt.ts'))
    assert.ok(prompt.includes('has tests'))
  })

  test('includes totalItems count in schema instruction', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app'
    })
    assert.ok(prompt.includes(`totalItems: ${basePlan.items.length}`))
  })

  test('includes success criteria when provided', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Add auth',
      plan: basePlan,
      workspaceName: 'app',
      successCriteria: ['All tests pass', 'Login endpoint returns JWT']
    })
    assert.ok(prompt.includes('Success Criteria'))
    assert.ok(prompt.includes('All tests pass'))
    assert.ok(prompt.includes('Login endpoint returns JWT'))
    assert.ok(prompt.includes('criteriaResults'))
  })

  test('omits success criteria when empty', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app',
      successCriteria: []
    })
    assert.ok(!prompt.includes('Success Criteria'))
  })

  test('omits success criteria when not provided', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app'
    })
    assert.ok(!prompt.includes('Success Criteria'))
  })

  test('filters empty criteria strings', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Build',
      plan: basePlan,
      workspaceName: 'app',
      successCriteria: ['Valid criterion', '   ', '']
    })
    // Only 1 valid criterion should appear
    assert.ok(prompt.includes('Valid criterion'))
  })

  test('includes read-only verification instructions', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Check',
      plan: basePlan,
      workspaceName: 'app'
    })
    assert.ok(prompt.includes('Read-only'))
    assert.ok(prompt.includes('goal-verify-item'))
    assert.ok(prompt.includes('goal-verify-report'))
  })

  test('mentions Bash test commands', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'Verify',
      plan: basePlan,
      workspaceName: 'app'
    })
    assert.ok(prompt.includes('npm test'))
    assert.ok(prompt.includes('npx eslint'))
    assert.ok(prompt.includes('npx tsc'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
