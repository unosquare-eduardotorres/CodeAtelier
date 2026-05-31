/**
 * MPA Orchestration — verifies artifact parsing logic and phase templates.
 *
 * Tests the plan and verify-report parsers which are the core
 * data extraction functions of the orchestration service.
 * Does NOT test full orchestration (would require mocking AgentSessionService).
 *
 * Pure logic: no filesystem, no network, no Electron dependencies.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { parsePlanArtifact, parseVerifyReport } from '../mpa-artifact-parsers'

describe('MPA Artifact Parsers', () => {
  // ── Plan Parser ──

  test('parses goal-plan tagged code block', () => {
    const text = `Here is the plan:

\`\`\`goal-plan
{
  "goalType": "feature",
  "summary": "Add auth",
  "items": [
    { "id": "P1", "title": "Auth service", "description": "Create it", "files": ["src/auth.ts"], "scope": "backend", "dependsOn": [], "includesTests": true }
  ],
  "risks": [],
  "existingPatterns": []
}
\`\`\`

That's the plan.`

    const plan = parsePlanArtifact(text)
    assert.ok(plan)
    assert.equal(plan.goalType, 'feature')
    assert.equal(plan.items.length, 1)
    assert.equal(plan.items[0].id, 'P1')
  })

  test('parses plan from fallback JSON match', () => {
    const text = `I've analyzed the codebase. Here's what I recommend:

{"goalType": "refactor", "summary": "Refactor module", "items": [{"id": "P1", "title": "Extract service", "description": "Do it", "files": ["src/svc.ts"], "scope": "backend", "dependsOn": [], "includesTests": false}], "risks": [], "existingPatterns": []}`

    const plan = parsePlanArtifact(text)
    assert.ok(plan)
    assert.equal(plan.goalType, 'refactor')
    assert.equal(plan.items.length, 1)
  })

  test('returns null for text without plan', () => {
    const text = 'I investigated the codebase but could not produce a plan.'
    const plan = parsePlanArtifact(text)
    assert.equal(plan, null)
  })

  test('returns null for invalid JSON', () => {
    const text = '```goal-plan\n{invalid json}\n```'
    const plan = parsePlanArtifact(text)
    assert.equal(plan, null)
  })

  test('returns null for JSON without items array', () => {
    const text = '```goal-plan\n{"goalType": "feature"}\n```'
    const plan = parsePlanArtifact(text)
    assert.equal(plan, null)
  })

  // ── Verify Report Parser ──

  test('parses goal-verify-report tagged code block', () => {
    const text = `Verification complete:

\`\`\`goal-verify-report
{
  "allComplete": true,
  "totalItems": 3,
  "implemented": 3,
  "partial": 0,
  "missing": 0,
  "issues": [],
  "crossCutting": {
    "frontendBackendConnected": true,
    "backendDatabaseConnected": true,
    "routesRegistered": true,
    "testsPass": true
  },
  "testOutput": "All 15 tests passed"
}
\`\`\`

Everything looks good.`

    const report = parseVerifyReport(text)
    assert.ok(report)
    assert.equal(report.allComplete, true)
  })

  test('parses verify report with issues', () => {
    const text = `\`\`\`goal-verify-report
{
  "allComplete": false,
  "totalItems": 3,
  "implemented": 2,
  "partial": 1,
  "missing": 0,
  "issues": [{"planItemId": "P2", "status": "partial", "detail": "Missing error handler", "filesChecked": ["src/routes.ts"]}],
  "crossCutting": {"frontendBackendConnected": true, "backendDatabaseConnected": true, "routesRegistered": true, "testsPass": false},
  "testOutput": "2 tests failed"
}
\`\`\``

    const report = parseVerifyReport(text)
    assert.ok(report)
    assert.equal(report.allComplete, false)
  })

  test('returns null for text without verify report', () => {
    const report = parseVerifyReport('No verification was performed.')
    assert.equal(report, null)
  })

  test('returns null for invalid JSON in verify report', () => {
    const text = '```goal-verify-report\n{bad json}\n```'
    const report = parseVerifyReport(text)
    assert.equal(report, null)
  })
})
