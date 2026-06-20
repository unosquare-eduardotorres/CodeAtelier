/**
 * BlueprintReviewService — unit tests for buildApprovalSummary.
 *
 * Tests the private method via prototype access pattern (common in this codebase).
 * Covers: null completion, empty findings, all severity levels, coverage, recommendation formatting.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { BlueprintReviewService } from '../blueprint-review.service'

describe('BlueprintReviewService', () => {

  describe('buildApprovalSummary', () => {
    // Access private method via prototype for unit testing
    const buildSummary = (BlueprintReviewService.prototype as any).buildApprovalSummary

    test('returns fallback for null completion', () => {
      const result = buildSummary(null)
      assert.ok(result.includes('no structured findings'))
    })

    test('includes recommendation', () => {
      const result = buildSummary({ recommendation: 'proceed' })
      assert.ok(result.includes('Recommendation: proceed'))
    })

    test('replaces underscores in recommendation', () => {
      const result = buildSummary({ recommendation: 'fix_critical' })
      assert.ok(result.includes('Recommendation: fix critical'))
    })

    test('formats findings counts', () => {
      const result = buildSummary({
        recommendation: 'proceed',
        findings: { critical: 2, high: 3, medium: 1, low: 0 }
      })
      assert.ok(result.includes('2 critical'))
      assert.ok(result.includes('3 high'))
      assert.ok(result.includes('1 medium'))
      // low: 0 should be excluded (falsy)
      assert.ok(!result.includes('0 low'))
    })

    test('includes coverage when present', () => {
      const result = buildSummary({
        recommendation: 'proceed',
        coveragePercent: 95
      })
      assert.ok(result.includes('Coverage: 95%'))
    })

    test('handles empty findings object', () => {
      const result = buildSummary({
        recommendation: 'proceed',
        findings: {}
      })
      assert.ok(result.includes('Findings: none'))
    })

    test('defaults recommendation to unknown', () => {
      const result = buildSummary({})
      assert.ok(result.includes('Recommendation: unknown'))
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
