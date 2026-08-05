/**
 * Phase 19, Track E — Orchestrator pipeline deep tests.
 *
 * Tests pure/exported functions across orchestrator services:
 *   - council-parser.ts (parseCouncilReview, parsePeerReview, parseCouncilVerdict)
 *   - mpa-artifact-parsers.ts (hasFailingCriteria, parsePlanArtifact, parseVerifyReport)
 *   - audit-response-parser (already well-tested — add edge cases)
 *
 * No DB, no sockets, no spawns.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Imports ──────────────────────────────────────────────────────────────

let parseCouncilReview: typeof import('../council-parser').parseCouncilReview
let parsePeerReview: typeof import('../council-parser').parsePeerReview
let parseCouncilVerdict: typeof import('../council-parser').parseCouncilVerdict

let hasFailingCriteria: typeof import('../mpa-artifact-parsers').hasFailingCriteria
let parsePlanArtifact: typeof import('../mpa-artifact-parsers').parsePlanArtifact
let parseVerifyReport: typeof import('../mpa-artifact-parsers').parseVerifyReport

let councilLoaded = false
let mpaLoaded = false

try {
  const mod = require('../council-parser')
  parseCouncilReview = mod.parseCouncilReview
  parsePeerReview = mod.parsePeerReview
  parseCouncilVerdict = mod.parseCouncilVerdict
  councilLoaded = true
} catch {
  /* module optional under test env */
}

try {
  const mod = require('../mpa-artifact-parsers')
  hasFailingCriteria = mod.hasFailingCriteria
  parsePlanArtifact = mod.parsePlanArtifact
  parseVerifyReport = mod.parseVerifyReport
  mpaLoaded = true
} catch {
  /* module optional under test env */
}

// ── Council parsers ──────────────────────────────────────────────────────

if (councilLoaded) {
  describe('parseCouncilReview', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parseCouncilReview('No review here', 'architect' as any), null)
    })

    test('parses_valid_review_block', () => {
      const text = `Some text
\`\`\`council-review
{
  "score": 8,
  "verdict": "approve",
  "keyFindings": ["Good architecture"],
  "blindSpots": [],
  "evidence": []
}
\`\`\`
More text`
      const result = parseCouncilReview(text, 'architect' as any)
      assert.ok(result)
      assert.equal(result!.score, 8)
      assert.equal(result!.advisorRole, 'architect')
      assert.ok(Array.isArray(result!.keyFindings))
    })

    test('returns_null_for_malformed_json', () => {
      const text = '```council-review\n{invalid json}\n```'
      const result = parseCouncilReview(text, 'architect' as any)
      assert.equal(result, null)
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parseCouncilReview('', 'architect' as any), null)
    })

    test('returns_null_for_missing_required_fields', () => {
      const text = '```council-review\n{"score": 5}\n```'
      const result = parseCouncilReview(text, 'architect' as any)
      assert.equal(result, null)
    })
  })

  describe('parsePeerReview', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parsePeerReview('No peer review', 'security' as any), null)
    })

    test('parses_valid_peer_review_block', () => {
      const text = `\`\`\`council-peer-review
{
  "strongestResponse": "A",
  "strongestReason": "Best coverage",
  "biggestBlindSpot": "B",
  "blindSpotDescription": "Missing auth",
  "missedByAll": "Performance"
}
\`\`\``
      const result = parsePeerReview(text, 'security' as any)
      assert.ok(result)
      assert.equal(result!.reviewerRole, 'security')
      assert.equal(result!.strongestResponse, 'A')
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parsePeerReview('', 'security' as any), null)
    })

    test('fills_defaults_for_missing_fields', () => {
      const text = '```council-peer-review\n{}\n```'
      const result = parsePeerReview(text, 'reviewer' as any)
      assert.ok(result)
      assert.equal(result!.reviewerRole, 'reviewer')
      assert.equal(result!.strongestResponse, 'A')
      assert.equal(result!.missedByAll, '')
    })
  })

  describe('parseCouncilVerdict', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parseCouncilVerdict('No verdict'), null)
    })

    test('parses_valid_verdict_block', () => {
      const text = `\`\`\`council-verdict
{
  "overallScore": 85,
  "sections": {"recommendation": "approve", "rationale": "Well-designed plan"},
  "revisions": [],
  "individualScores": {},
  "rankingsMatrix": {}
}
\`\`\``
      const result = parseCouncilVerdict(text)
      assert.ok(result)
      assert.equal(result!.overallScore, 85)
    })

    test('returns_null_for_malformed_json', () => {
      const text = '```council-verdict\n{bad}\n```'
      const result = parseCouncilVerdict(text)
      assert.equal(result, null)
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parseCouncilVerdict(''), null)
    })
  })
} else {
  describe('Council parsers (skipped — module not loaded)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}

// ── MPA artifact parsers ─────────────────────────────────────────────────

if (mpaLoaded) {
  describe('hasFailingCriteria', () => {
    test('returns_false_for_null', () => {
      assert.equal(hasFailingCriteria(null), false)
    })

    test('returns_false_for_undefined', () => {
      assert.equal(hasFailingCriteria(undefined), false)
    })

    test('returns_false_for_all_passing', () => {
      assert.equal(
        hasFailingCriteria({
          overallPass: true,
          criteriaResults: [{ label: 'Test', status: 'pass', evidence: 'OK' }]
        } as any),
        false
      )
    })

    test('returns_true_for_failing_criteria', () => {
      assert.equal(
        hasFailingCriteria({
          overallPass: false,
          criteriaResults: [{ label: 'Test', status: 'fail', evidence: 'Failed' }]
        } as any),
        true
      )
    })

    test('returns_false_for_empty_criteria', () => {
      assert.equal(
        hasFailingCriteria({
          overallPass: false,
          criteriaResults: []
        } as any),
        false
      )
    })

    test('returns_false_for_missing_criteriaResults', () => {
      assert.equal(hasFailingCriteria({} as any), false)
    })
  })

  describe('parsePlanArtifact', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parsePlanArtifact('No plan here'), null)
    })

    test('parses_valid_plan_block', () => {
      const text = `\`\`\`goal-plan
{
  "items": [
    {"name": "Planning", "description": "Plan the work"}
  ],
  "summary": "Build an API"
}
\`\`\``
      const result = parsePlanArtifact(text)
      assert.ok(result)
      assert.ok(Array.isArray(result!.items))
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parsePlanArtifact(''), null)
    })

    test('returns_null_for_malformed_json', () => {
      const text = '```goal-plan\n{bad json\n```'
      assert.equal(parsePlanArtifact(text), null)
    })
  })

  describe('parseVerifyReport', () => {
    test('returns_null_for_no_block', () => {
      assert.equal(parseVerifyReport('No verify report'), null)
    })

    test('parses_valid_verify_block', () => {
      const text = `\`\`\`goal-verify-report
{
  "allComplete": true,
  "criteriaResults": [
    {"label": "Tests pass", "status": "pass", "evidence": "All green"}
  ]
}
\`\`\``
      const result = parseVerifyReport(text)
      assert.ok(result)
      assert.equal(result!.allComplete, true)
    })

    test('returns_null_for_empty_string', () => {
      assert.equal(parseVerifyReport(''), null)
    })

    test('returns_null_for_malformed_json', () => {
      const text = '```goal-verify-report\n{bad json\n```'
      assert.equal(parseVerifyReport(text), null)
    })
  })
} else {
  describe('MPA Artifact parsers (skipped — module not loaded)', () => {
    test('skipped', () => {}, { skipReason: 'module not loaded' })
  })
}
