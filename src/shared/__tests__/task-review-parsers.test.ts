/**
 * Unit tests for the review-findings parsers.
 *
 * The rubric is a hard constraint, not a suggestion in a prompt. A cheap model
 * asked to review a diff reliably returns style opinions; passing those through
 * costs a build round-trip each and teaches the user to ignore the layer. The
 * parser is where that gets enforced.
 *
 * Run: tsx src/shared/__tests__/task-review-parsers.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import { parseLeadReview, parsePeerReview } from '../blueprint-artifact-parsers'

const block = (body: unknown): string =>
  `Here is my review.\n\n\`\`\`blueprint-review-findings\n${JSON.stringify(body)}\n\`\`\`\n`

const finding = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  category: 'ac-coverage',
  file: 'src/a.ts',
  issue: 'AC 2 (returns 404 for unknown ids) is not implemented',
  requiredChange: 'In getUser(), return res.status(404) when the repository returns null',
  howVerified: 'npm test src/a.test.ts',
  ...over
})

describe('parsePeerReview', () => {
  test('a well-formed finding survives intact', () => {
    const result = parsePeerReview(block({ findings: [finding()] }))
    assert.equal(result.findings.length, 1)
    assert.equal(result.findings[0].category, 'ac-coverage')
    assert.equal(result.findings[0].file, 'src/a.ts')
    assert.deepEqual(result.rejected, [])
  })

  test('a bare array is accepted as well as { findings: [...] }', () => {
    assert.equal(parsePeerReview(block([finding()])).findings.length, 1)
  })

  test('an off-rubric style opinion is rejected, with the reason recorded', () => {
    const result = parsePeerReview(
      block({ findings: [finding({ category: 'style', issue: 'prefer const over let' })] })
    )
    assert.deepEqual(result.findings, [])
    assert.equal(result.rejected.length, 1)
    assert.match(result.rejected[0].reason, /outside the rubric/)
  })

  test('the peer rubric does not admit the lead-only categories', () => {
    const result = parsePeerReview(block({ findings: [finding({ category: 'spec-drift' })] }))
    assert.deepEqual(result.findings, [])
    assert.equal(result.rejected.length, 1)
  })

  test('a finding with no actionable change is rejected — it would only cost another attempt', () => {
    const result = parsePeerReview(block({ findings: [finding({ requiredChange: '' })] }))
    assert.deepEqual(result.findings, [])
    assert.match(result.rejected[0].reason, /mechanically actionable/)
  })

  test('a finding with no file is rejected', () => {
    const result = parsePeerReview(block({ findings: [finding({ file: '  ' })] }))
    assert.deepEqual(result.findings, [])
    assert.match(result.rejected[0].reason, /no file/)
  })

  test('good and bad findings in one response are separated, not discarded wholesale', () => {
    const result = parsePeerReview(
      block({ findings: [finding(), finding({ category: 'vibes' }), finding({ file: '' })] })
    )
    assert.equal(result.findings.length, 1)
    assert.equal(result.rejected.length, 2)
  })

  test('findings are capped so a review cannot become a rewrite', () => {
    const many = Array.from({ length: 50 }, () => finding())
    assert.equal(parsePeerReview(block({ findings: many })).findings.length, 20)
  })

  test('no block, malformed JSON and a non-finding payload all yield nothing', () => {
    assert.deepEqual(parsePeerReview('looks fine to me').findings, [])
    assert.deepEqual(parsePeerReview('```blueprint-review-findings\nnot json\n```').findings, [])
    assert.deepEqual(parsePeerReview(block({ findings: 'none' })).findings, [])
  })
})

describe('parseLeadReview', () => {
  test('approved with no findings is an approval', () => {
    const result = parseLeadReview(block({ verdict: 'approved', findings: [] }))
    assert.equal(result.verdict, 'approved')
  })

  test('"approved" WITH findings is not an approval — the findings would ship unfixed', () => {
    const result = parseLeadReview(block({ verdict: 'approved', findings: [finding()] }))
    assert.equal(result.verdict, 'changes-required')
    assert.equal(result.findings.length, 1)
  })

  test('the lead rubric admits spec-drift and test-gaming', () => {
    const result = parseLeadReview(
      block({
        verdict: 'changes-required',
        findings: [
          finding({ category: 'spec-drift' }),
          finding({ category: 'test-gaming' }),
          finding({ category: 'correctness' })
        ]
      })
    )
    assert.equal(result.findings.length, 3)
    assert.deepEqual(result.rejected, [])
  })

  test('a missing verdict defaults to changes-required, not to approval', () => {
    assert.equal(parseLeadReview(block({ findings: [] })).verdict, 'changes-required')
    assert.equal(parseLeadReview('no block at all').verdict, 'changes-required')
  })

  test('an off-rubric category is still rejected at lead level', () => {
    const result = parseLeadReview(
      block({ verdict: 'changes-required', findings: [finding({ category: 'nitpick' })] })
    )
    assert.deepEqual(result.findings, [])
    assert.equal(result.rejected.length, 1)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
