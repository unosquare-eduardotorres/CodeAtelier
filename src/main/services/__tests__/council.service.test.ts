/**
 * CouncilService — unit tests.
 *
 * Tests:
 *   - Structured output parsing (council-review, council-peer-review, council-verdict)
 *   - Validation of parsed structures
 *   - Edge cases (malformed JSON, missing fields, multiple blocks)
 */

import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// Parsers are now standalone pure functions (extracted from CouncilService)
import { parseCouncilReview, parsePeerReview, parseCouncilVerdict } from '../council-parser'

describe('CouncilService', () => {
  // ── council-review parsing ──────────────────────────────────────────

  describe('parseCouncilReview', () => {
    test('parses valid council-review block', () => {
      const text = `Here is my analysis...

\`\`\`council-review
{
  "advisorRole": "contrarian",
  "score": 68,
  "verdict": "proceed-with-changes",
  "keyFindings": ["finding 1", "finding 2"],
  "blindSpots": ["blind spot 1"],
  "evidence": [{ "file": "src/main/index.ts", "finding": "missing error handling" }],
  "summary": "The plan has merit but needs improvements."
}
\`\`\`

And some trailing text.`

      const result = parseCouncilReview(text, 'contrarian')
      assert.ok(result)
      assert.equal(result.score, 68)
      assert.equal(result.verdict, 'proceed-with-changes')
      assert.equal(result.advisorRole, 'contrarian')
      assert.equal(result.keyFindings.length, 2)
      assert.equal(result.blindSpots.length, 1)
      assert.equal(result.evidence.length, 1)
    })

    test('uses last block when multiple blocks are emitted', () => {
      const text = `First attempt:
\`\`\`council-review
{
  "advisorRole": "executor",
  "score": 50,
  "verdict": "needs-revision",
  "keyFindings": ["old finding"],
  "blindSpots": [],
  "evidence": [],
  "summary": "old summary"
}
\`\`\`

Wait, let me reconsider...

\`\`\`council-review
{
  "advisorRole": "executor",
  "score": 72,
  "verdict": "proceed-with-changes",
  "keyFindings": ["new finding"],
  "blindSpots": [],
  "evidence": [],
  "summary": "new summary"
}
\`\`\``

      const result = parseCouncilReview(text, 'executor')
      assert.ok(result)
      assert.equal(result.score, 72)
      assert.equal(result.summary, 'new summary')
    })

    test('returns null for missing block', () => {
      const result = parseCouncilReview('Just plain text with no JSON block.', 'outsider')
      assert.equal(result, null)
    })

    test('returns null for invalid JSON', () => {
      const text = `\`\`\`council-review
{ invalid json here }
\`\`\``
      const result = parseCouncilReview(text, 'contrarian')
      assert.equal(result, null)
    })

    test('returns null when score is not a number', () => {
      const text = `\`\`\`council-review
{
  "advisorRole": "contrarian",
  "score": "high",
  "verdict": "proceed-with-changes",
  "keyFindings": ["f1"],
  "blindSpots": [],
  "evidence": [],
  "summary": "test"
}
\`\`\``
      const result = parseCouncilReview(text, 'contrarian')
      assert.equal(result, null)
    })

    test('returns null when keyFindings is not an array', () => {
      const text = `\`\`\`council-review
{
  "advisorRole": "contrarian",
  "score": 50,
  "verdict": "proceed-with-changes",
  "keyFindings": "not an array",
  "blindSpots": [],
  "evidence": [],
  "summary": "test"
}
\`\`\``
      const result = parseCouncilReview(text, 'contrarian')
      assert.equal(result, null)
    })

    test('overrides advisorRole with expected role', () => {
      const text = `\`\`\`council-review
{
  "advisorRole": "wrong-role",
  "score": 60,
  "verdict": "needs-revision",
  "keyFindings": ["f1"],
  "blindSpots": [],
  "evidence": [],
  "summary": "test"
}
\`\`\``
      const result = parseCouncilReview(text, 'expansionist')
      assert.ok(result)
      assert.equal(result.advisorRole, 'expansionist')
    })

    test('normalizes missing optional arrays', () => {
      const text = `\`\`\`council-review
{
  "advisorRole": "outsider",
  "score": 45,
  "verdict": "rethink",
  "keyFindings": ["the plan is unclear"],
  "summary": "Not self-explanatory."
}
\`\`\``
      const result = parseCouncilReview(text, 'outsider')
      assert.ok(result)
      assert.deepEqual(result.blindSpots, [])
      assert.deepEqual(result.evidence, [])
    })
  })

  // ── council-verdict parsing ─────────────────────────────────────────

  describe('parseCouncilVerdict', () => {
    test('parses valid council-verdict block', () => {
      const verdictText = `\`\`\`council-verdict
{
  "overallScore": 74,
  "sections": {
    "agrees": "All advisors agree on X.",
    "clashes": "Contrarian vs Expansionist on Y.",
    "blindSpots": "Nobody considered Z.",
    "recommendation": "Proceed with caution.",
    "oneThingFirst": "Fix the authentication flow first."
  },
  "revisions": [
    {
      "priority": "high",
      "description": "Add error handling to auth flow",
      "consensus": "4/5 advisors",
      "evidence": "src/auth.ts:42"
    }
  ],
  "individualScores": {
    "contrarian": 68,
    "first-principles": 72,
    "expansionist": 80,
    "outsider": 55,
    "executor": 75
  },
  "rankingsMatrix": {}
}
\`\`\``

      const result = parseCouncilVerdict(verdictText)
      assert.ok(result)
      assert.equal(result.overallScore, 74)
      assert.equal(result.sections.oneThingFirst, 'Fix the authentication flow first.')
      assert.equal(result.revisions.length, 1)
      assert.equal(result.revisions[0].priority, 'high')
    })

    test('returns null for missing verdict block', () => {
      assert.equal(parseCouncilVerdict('no verdict here'), null)
    })
  })

  // ── peer-review parsing ─────────────────────────────────────────────

  describe('parsePeerReview', () => {
    test('parses valid peer-review block', () => {
      const text = `\`\`\`council-peer-review
{
  "strongestResponse": "C",
  "strongestReason": "Most evidence-backed analysis",
  "biggestBlindSpot": "A",
  "blindSpotDescription": "Ignored scalability concerns",
  "missedByAll": "No one considered the migration path"
}
\`\`\``

      const result = parsePeerReview(text, 'contrarian')
      assert.ok(result)
      assert.equal(result.strongestResponse, 'C')
      assert.equal(result.biggestBlindSpot, 'A')
      assert.equal(result.reviewerRole, 'contrarian')
    })

    test('returns null for missing peer-review block', () => {
      assert.equal(parsePeerReview('no review here', 'outsider'), null)
    })
  })

  // ── Outsider tool access ────────────────────────────────────────────

  describe('advisor tool access', () => {
    test('COUNCIL_ADVISORS defines outsider with no tools', async () => {
      const { COUNCIL_ADVISORS } = await import('../../../shared/constants')
      assert.equal(COUNCIL_ADVISORS.outsider.toolAccess, 'none')
    })

    test('COUNCIL_ADVISORS defines other roles with full tool access', async () => {
      const { COUNCIL_ADVISORS } = await import('../../../shared/constants')
      assert.equal(COUNCIL_ADVISORS.contrarian.toolAccess, 'full')
      assert.equal(COUNCIL_ADVISORS['first-principles'].toolAccess, 'full')
      assert.equal(COUNCIL_ADVISORS.expansionist.toolAccess, 'full')
      assert.equal(COUNCIL_ADVISORS.executor.toolAccess, 'full')
    })

    test('all 5 advisor roles are defined', async () => {
      const { COUNCIL_ADVISOR_ROLES } = await import('../../../shared/constants')
      assert.equal(COUNCIL_ADVISOR_ROLES.length, 5)
      assert.ok(COUNCIL_ADVISOR_ROLES.includes('contrarian'))
      assert.ok(COUNCIL_ADVISOR_ROLES.includes('first-principles'))
      assert.ok(COUNCIL_ADVISOR_ROLES.includes('expansionist'))
      assert.ok(COUNCIL_ADVISOR_ROLES.includes('outsider'))
      assert.ok(COUNCIL_ADVISOR_ROLES.includes('executor'))
    })
  })
})
