/**
 * Unit tests for council-parser.ts — parses fenced council JSON blocks.
 * Pure logic (electron-log is import-safe under tsx).
 *
 * Coverage: extractLastFencedBlock (via multi-block "use last"), parseCouncilReview,
 * parsePeerReview, parseCouncilVerdict — happy path, missing fields, malformed JSON.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseCouncilReview, parsePeerReview, parseCouncilVerdict } from '../council-parser'

function fence(tag: string, obj: unknown): string {
  return '```' + tag + '\n' + JSON.stringify(obj) + '\n```'
}

describe('parseCouncilReview', () => {
  const valid = { score: 8, verdict: 'approve', keyFindings: ['a', 'b'] }

  test('parses a valid review and fills advisorRole + default arrays', () => {
    const out = parseCouncilReview(fence('council-review', valid), 'contrarian')
    assert.ok(out)
    assert.equal(out!.advisorRole, 'contrarian')
    assert.deepEqual(out!.blindSpots, [])
    assert.deepEqual(out!.evidence, [])
  })

  test('returns null when no fenced block present', () => {
    assert.equal(parseCouncilReview('no blocks here', 'contrarian'), null)
  })

  test('returns null when required fields are missing', () => {
    const out = parseCouncilReview(fence('council-review', { score: 8 }), 'contrarian')
    assert.equal(out, null)
  })

  test('returns null on malformed JSON', () => {
    const out = parseCouncilReview('```council-review\n{ bad json\n```', 'contrarian')
    assert.equal(out, null)
  })

  test('uses the LAST block when multiple are present', () => {
    const text =
      fence('council-review', { ...valid, score: 1 }) +
      '\n' +
      fence('council-review', { ...valid, score: 9 })
    const out = parseCouncilReview(text, 'contrarian')
    assert.equal(out!.score, 9)
  })
})

describe('parsePeerReview', () => {
  test('parses and applies defaults for missing optional fields', () => {
    const out = parsePeerReview(
      fence('council-peer-review', { strongestResponse: 'B' }),
      'outsider'
    )
    assert.ok(out)
    assert.equal(out!.reviewerRole, 'outsider')
    assert.equal(out!.strongestResponse, 'B')
    assert.equal(out!.strongestReason, '')
    assert.equal(out!.biggestBlindSpot, 'A') // default
  })

  test('returns null when block absent', () => {
    assert.equal(parsePeerReview('nothing', 'outsider'), null)
  })

  test('returns null on malformed JSON', () => {
    assert.equal(parsePeerReview('```council-peer-review\n{oops\n```', 'outsider'), null)
  })
})

describe('parseCouncilVerdict', () => {
  const valid = { overallScore: 7, sections: { recommendation: 'ship it' } }

  test('parses valid verdict and normalises optional fields', () => {
    const out = parseCouncilVerdict(fence('council-verdict', valid))
    assert.ok(out)
    assert.deepEqual(out!.revisions, [])
    assert.deepEqual(out!.rankingsMatrix, {})
  })

  test('returns null when recommendation section is missing', () => {
    const out = parseCouncilVerdict(fence('council-verdict', { overallScore: 7, sections: {} }))
    assert.equal(out, null)
  })

  test('returns null on malformed JSON', () => {
    assert.equal(parseCouncilVerdict('```council-verdict\nnope\n```'), null)
  })

  test('returns null when no block present', () => {
    assert.equal(parseCouncilVerdict('plain text'), null)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
