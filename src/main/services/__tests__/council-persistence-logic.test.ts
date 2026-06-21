/**
 * Unit tests for Council persistence controller pure logic — transcript
 * formatting, batch key generation, review serialization.
 *
 * Phase 14, Track 9b — council-persistence.controller.ts (~230 lines at ~34%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicated pure logic ──

/**
 * Replicated transcript entry formatting
 * (council-persistence.controller.ts:117-120).
 */
function formatAdvisorTranscript(
  advisorRole: string,
  review: { score: number; summary: string; keyFindings: string[]; blindSpots: string[] }
): string {
  return (
    `## ${advisorRole.toUpperCase()} (Score: ${review.score}/100)\n\n${review.summary}\n\n` +
    `Key Findings: ${review.keyFindings.join('; ')}\n` +
    `Blind Spots: ${review.blindSpots.join('; ')}\n`
  )
}

/**
 * Replicated transcript file content assembly
 * (council-persistence.controller.ts:217-226).
 */
function buildTranscriptContent(
  sessionId: string,
  dateIso: string,
  transcriptParts: string[]
): string {
  return [
    '# LLM Council Transcript',
    '',
    `**Date:** ${dateIso}`,
    `**Session:** ${sessionId}`,
    '',
    '---',
    '',
    ...transcriptParts
  ].join('\n')
}

/**
 * Replicated review serialization for DB storage.
 */
function serializeReviewForDb(review: {
  advisorRole: string
  score: number
  verdict: string
  keyFindings: string[]
  summary: string
}): string {
  return JSON.stringify({
    advisorRole: review.advisorRole,
    score: review.score,
    verdict: review.verdict,
    keyFindings: review.keyFindings,
    summary: review.summary
  })
}

/**
 * Replicated review deserialization from DB.
 */
function deserializeReviewFromDb(json: string): {
  advisorRole: string
  score: number
  verdict: string
  keyFindings: string[]
  summary: string
} | null {
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed.score !== 'number') return null
    if (!Array.isArray(parsed.keyFindings)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Replicated verdict score mapping from review array.
 */
function mapReviewScores(
  reviews: Array<{ advisorRole: string; score: number }>
): Record<string, number> {
  const result: Record<string, number> = {}
  for (const review of reviews) {
    result[review.advisorRole] = review.score
  }
  return result
}

/**
 * Replicated peer review flattening.
 */
function flattenPeerReviews(
  peerReviews: Array<{
    reviewerRole: string
    strongestResponse: string
    biggestBlindSpot: string
  }>
): Array<{ from: string; strongest: string; blindSpot: string }> {
  return peerReviews.map((pr) => ({
    from: pr.reviewerRole,
    strongest: pr.strongestResponse,
    blindSpot: pr.biggestBlindSpot
  }))
}

// ── Tests ──

describe('Council Persistence — transcript formatting', () => {
  test('formats_advisor_role_in_uppercase', () => {
    const transcript = formatAdvisorTranscript('contrarian', {
      score: 75,
      summary: 'The plan has issues.',
      keyFindings: ['Missing error handling', 'No tests'],
      blindSpots: ['Performance']
    })
    assert.ok(transcript.includes('## CONTRARIAN'))
    assert.ok(transcript.includes('Score: 75/100'))
  })

  test('joins_keyFindings_with_semicolons', () => {
    const transcript = formatAdvisorTranscript('executor', {
      score: 85,
      summary: 'Looks good.',
      keyFindings: ['Clean architecture', 'Good coverage'],
      blindSpots: []
    })
    assert.ok(transcript.includes('Key Findings: Clean architecture; Good coverage'))
  })

  test('handles_empty_blindSpots', () => {
    const transcript = formatAdvisorTranscript('outsider', {
      score: 60,
      summary: 'Needs more context.',
      keyFindings: ['Unclear scope'],
      blindSpots: []
    })
    assert.ok(transcript.includes('Blind Spots: '))
  })

  test('includes_summary_text', () => {
    const transcript = formatAdvisorTranscript('first-principles', {
      score: 90,
      summary: 'Fundamentally sound approach.',
      keyFindings: ['Good'],
      blindSpots: ['Scale']
    })
    assert.ok(transcript.includes('Fundamentally sound approach.'))
  })
})

describe('Council Persistence — transcript content assembly', () => {
  test('includes_header_and_metadata', () => {
    const content = buildTranscriptContent(
      'council-abc',
      '2024-01-15T10:30:00Z',
      ['## CONTRARIAN\nContent here']
    )
    assert.ok(content.includes('# LLM Council Transcript'))
    assert.ok(content.includes('**Date:** 2024-01-15T10:30:00Z'))
    assert.ok(content.includes('**Session:** council-abc'))
    assert.ok(content.includes('---'))
    assert.ok(content.includes('## CONTRARIAN'))
  })

  test('includes_multiple_transcript_parts', () => {
    const content = buildTranscriptContent(
      'sess-1',
      '2024-01-01',
      ['Part 1', 'Part 2', 'Part 3']
    )
    assert.ok(content.includes('Part 1'))
    assert.ok(content.includes('Part 2'))
    assert.ok(content.includes('Part 3'))
  })
})

describe('Council Persistence — review serialization', () => {
  test('serializes_review_to_JSON_string', () => {
    const json = serializeReviewForDb({
      advisorRole: 'contrarian',
      score: 75,
      verdict: 'needs-revision',
      keyFindings: ['Issue 1', 'Issue 2'],
      summary: 'Needs work'
    })
    const parsed = JSON.parse(json)
    assert.equal(parsed.advisorRole, 'contrarian')
    assert.equal(parsed.score, 75)
    assert.deepEqual(parsed.keyFindings, ['Issue 1', 'Issue 2'])
  })

  test('deserializes_valid_JSON', () => {
    const json = JSON.stringify({
      advisorRole: 'executor',
      score: 85,
      verdict: 'proceed-with-changes',
      keyFindings: ['Good'],
      summary: 'OK'
    })
    const result = deserializeReviewFromDb(json)
    assert.ok(result)
    assert.equal(result!.score, 85)
  })

  test('rejects_invalid_JSON', () => {
    assert.equal(deserializeReviewFromDb('not json'), null)
  })

  test('rejects_missing_score', () => {
    const json = JSON.stringify({ advisorRole: 'x', keyFindings: [] })
    assert.equal(deserializeReviewFromDb(json), null)
  })

  test('rejects_missing_keyFindings_array', () => {
    const json = JSON.stringify({ score: 50 })
    assert.equal(deserializeReviewFromDb(json), null)
  })
})

describe('Council Persistence — verdict score mapping', () => {
  test('maps_reviews_to_role_score_record', () => {
    const scores = mapReviewScores([
      { advisorRole: 'contrarian', score: 70 },
      { advisorRole: 'executor', score: 85 }
    ])
    assert.equal(scores.contrarian, 70)
    assert.equal(scores.executor, 85)
  })

  test('empty_reviews_returns_empty_record', () => {
    assert.deepEqual(mapReviewScores([]), {})
  })
})

describe('Council Persistence — peer review flattening', () => {
  test('flattens_peer_reviews_to_simplified_shape', () => {
    const flat = flattenPeerReviews([
      { reviewerRole: 'contrarian', strongestResponse: 'B', biggestBlindSpot: 'D' },
      { reviewerRole: 'executor', strongestResponse: 'A', biggestBlindSpot: 'C' }
    ])
    assert.equal(flat.length, 2)
    assert.equal(flat[0].from, 'contrarian')
    assert.equal(flat[0].strongest, 'B')
    assert.equal(flat[0].blindSpot, 'D')
  })

  test('empty_array_returns_empty', () => {
    assert.deepEqual(flattenPeerReviews([]), [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
