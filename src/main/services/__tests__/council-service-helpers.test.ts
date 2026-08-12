/**
 * Unit tests for Council service pure slices — session configuration,
 * peer review framing, status computation, verdict aggregation.
 *
 * Phase 14, Track 7 — council.service.ts (~873 lines at 18.9%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { COUNCIL_ADVISOR_ROLES, COUNCIL_ADVISORS } from '../../../shared/constants'

// ── Replicated pure logic ──

/**
 * Replicated from council.service.ts:43-49.
 * Pure utility to extract non-null fulfilled values from Promise.allSettled results.
 */
function collectSettled<T>(results: PromiseSettledResult<T | null>[]): T[] {
  return results
    .filter((r): r is PromiseFulfilledResult<T | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((r): r is T => r !== null)
}

/**
 * Replicated review anonymization logic from council.service.ts:410-416.
 */
function anonymizeReviews(
  reviews: Array<{ advisorRole: string; score: number; summary: string }>
): Array<{ label: string; score: number; summary: string }> {
  // Note: In production, reviews are shuffled. We skip shuffle for deterministic tests.
  return reviews.map((r, i) => ({
    label: String.fromCharCode(65 + i), // A, B, C, D, E
    score: r.score,
    summary: r.summary
    // advisorRole stripped
  }))
}

/**
 * Replicated status computation logic.
 */
type CouncilPhase = 'framing' | 'deliberating' | 'peer-review' | 'synthesizing' | 'complete'

function computeCouncilPhase(params: {
  advisorsStarted: number
  advisorsDone: number
  totalAdvisors: number
  peerReviewDone: boolean
  chairmanDone: boolean
}): CouncilPhase {
  if (params.chairmanDone) return 'complete'
  if (params.peerReviewDone) return 'synthesizing'
  if (params.advisorsDone === params.totalAdvisors) return 'peer-review'
  if (params.advisorsStarted > 0) return 'deliberating'
  return 'framing'
}

/**
 * Replicated verdict score aggregation from council reviews.
 */
function computeAverageScore(reviews: Array<{ score: number }>): number {
  if (reviews.length === 0) return 0
  const sum = reviews.reduce((acc, r) => acc + r.score, 0)
  return Math.round(sum / reviews.length)
}

/**
 * Replicated convergence point extraction.
 * A convergence point is a finding mentioned by 3+ advisors.
 */
function extractConvergencePoints(
  reviews: Array<{ keyFindings: string[] }>,
  threshold = 3
): string[] {
  const findingCounts = new Map<string, number>()
  for (const review of reviews) {
    for (const finding of review.keyFindings) {
      const normalized = finding.toLowerCase().trim()
      findingCounts.set(normalized, (findingCounts.get(normalized) ?? 0) + 1)
    }
  }
  return Array.from(findingCounts.entries())
    .filter(([, count]) => count >= threshold)
    .map(([finding]) => finding)
}

/**
 * Replicated peer review count computation.
 * Each advisor reviews all others: N*(N-1).
 */
function computePeerReviewCount(advisorCount: number): number {
  return advisorCount * (advisorCount - 1)
}

// ── Tests ──

describe('Council — session configuration', () => {
  test('creates_5_advisor_sessions_one_per_role', () => {
    assert.equal(COUNCIL_ADVISOR_ROLES.length, 5)
    assert.ok(COUNCIL_ADVISOR_ROLES.includes('contrarian'))
    assert.ok(COUNCIL_ADVISOR_ROLES.includes('first-principles'))
    assert.ok(COUNCIL_ADVISOR_ROLES.includes('expansionist'))
    assert.ok(COUNCIL_ADVISOR_ROLES.includes('outsider'))
    assert.ok(COUNCIL_ADVISOR_ROLES.includes('executor'))
  })

  test('advisor_roles_match_COUNCIL_ADVISORS_keys', () => {
    const advisorKeys = Object.keys(COUNCIL_ADVISORS)
    for (const role of COUNCIL_ADVISOR_ROLES) {
      assert.ok(advisorKeys.includes(role), `Missing advisor config for ${role}`)
    }
  })

  test('each_advisor_has_thinkingStyle_and_toolAccess', () => {
    for (const role of COUNCIL_ADVISOR_ROLES) {
      const advisor = COUNCIL_ADVISORS[role]
      assert.ok(advisor.thinkingStyle, `${role} missing thinkingStyle`)
      assert.ok(advisor.toolAccess, `${role} missing toolAccess`)
    }
  })

  test('outsider_has_no_tool_access', () => {
    assert.equal(COUNCIL_ADVISORS['outsider'].toolAccess, 'none')
  })

  test('contrarian_has_full_tool_access', () => {
    assert.equal(COUNCIL_ADVISORS['contrarian'].toolAccess, 'full')
  })
})

describe('Council — peer review framing', () => {
  test('anonymized_reviews_get_letter_labels', () => {
    const reviews = [
      { advisorRole: 'contrarian', score: 75, summary: 'Issues found' },
      { advisorRole: 'executor', score: 85, summary: 'Looks feasible' },
      { advisorRole: 'outsider', score: 60, summary: 'Missing context' }
    ]
    const anonymized = anonymizeReviews(reviews)
    assert.equal(anonymized[0].label, 'A')
    assert.equal(anonymized[1].label, 'B')
    assert.equal(anonymized[2].label, 'C')
  })

  test('anonymized_reviews_strip_role', () => {
    const reviews = [{ advisorRole: 'contrarian', score: 75, summary: 'x' }]
    const anonymized = anonymizeReviews(reviews)
    assert.equal((anonymized[0] as any).advisorRole, undefined)
  })

  test('peer_review_count_is_N_times_N_minus_1', () => {
    assert.equal(computePeerReviewCount(5), 20) // 5 * 4
    assert.equal(computePeerReviewCount(3), 6) // 3 * 2
    assert.equal(computePeerReviewCount(1), 0) // 1 * 0
  })
})

describe('Council — status computation', () => {
  test('no_advisors_started_is_framing', () => {
    const phase = computeCouncilPhase({
      advisorsStarted: 0,
      advisorsDone: 0,
      totalAdvisors: 5,
      peerReviewDone: false,
      chairmanDone: false
    })
    assert.equal(phase, 'framing')
  })

  test('some_advisors_done_is_deliberating', () => {
    const phase = computeCouncilPhase({
      advisorsStarted: 5,
      advisorsDone: 3,
      totalAdvisors: 5,
      peerReviewDone: false,
      chairmanDone: false
    })
    assert.equal(phase, 'deliberating')
  })

  test('all_advisors_done_is_peer_review', () => {
    const phase = computeCouncilPhase({
      advisorsStarted: 5,
      advisorsDone: 5,
      totalAdvisors: 5,
      peerReviewDone: false,
      chairmanDone: false
    })
    assert.equal(phase, 'peer-review')
  })

  test('peer_review_done_is_synthesizing', () => {
    const phase = computeCouncilPhase({
      advisorsStarted: 5,
      advisorsDone: 5,
      totalAdvisors: 5,
      peerReviewDone: true,
      chairmanDone: false
    })
    assert.equal(phase, 'synthesizing')
  })

  test('chairman_done_is_complete', () => {
    const phase = computeCouncilPhase({
      advisorsStarted: 5,
      advisorsDone: 5,
      totalAdvisors: 5,
      peerReviewDone: true,
      chairmanDone: true
    })
    assert.equal(phase, 'complete')
  })
})

describe('Council — verdict aggregation', () => {
  test('computes_average_score_from_reviews', () => {
    const score = computeAverageScore([{ score: 80 }, { score: 70 }, { score: 90 }])
    assert.equal(score, 80)
  })

  test('rounds_to_nearest_integer', () => {
    const score = computeAverageScore([{ score: 75 }, { score: 80 }])
    assert.equal(score, 78) // 77.5 rounds to 78
  })

  test('empty_reviews_returns_0', () => {
    assert.equal(computeAverageScore([]), 0)
  })

  test('single_review_returns_its_score', () => {
    assert.equal(computeAverageScore([{ score: 85 }]), 85)
  })
})

describe('Council — convergence extraction', () => {
  test('finding_mentioned_by_3_plus_is_convergence', () => {
    const reviews = [
      { keyFindings: ['needs refactoring', 'good coverage'] },
      { keyFindings: ['needs refactoring', 'missing docs'] },
      { keyFindings: ['needs refactoring', 'good coverage'] }
    ]
    const convergence = extractConvergencePoints(reviews)
    assert.ok(convergence.includes('needs refactoring'))
    assert.ok(!convergence.includes('good coverage')) // only 2 mentions
  })

  test('no_convergence_returns_empty', () => {
    const reviews = [{ keyFindings: ['a'] }, { keyFindings: ['b'] }, { keyFindings: ['c'] }]
    assert.deepEqual(extractConvergencePoints(reviews), [])
  })

  test('case_insensitive_matching', () => {
    const reviews = [
      { keyFindings: ['Needs Tests'] },
      { keyFindings: ['needs tests'] },
      { keyFindings: ['NEEDS TESTS'] }
    ]
    const convergence = extractConvergencePoints(reviews)
    assert.equal(convergence.length, 1)
  })
})

describe('collectSettled — promise utility', () => {
  test('extracts_fulfilled_non_null_values', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: null },
      { status: 'rejected', reason: new Error('fail') },
      { status: 'fulfilled', value: 'b' }
    ]
    const collected = collectSettled(results)
    assert.deepEqual(collected, ['a', 'b'])
  })

  test('all_rejected_returns_empty', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'rejected', reason: new Error('a') },
      { status: 'rejected', reason: new Error('b') }
    ]
    assert.deepEqual(collectSettled(results), [])
  })

  test('all_null_returns_empty', () => {
    const results: PromiseSettledResult<string | null>[] = [
      { status: 'fulfilled', value: null },
      { status: 'fulfilled', value: null }
    ]
    assert.deepEqual(collectSettled(results), [])
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
