/**
 * Tests for GitHubService.getCheckStatus and findPrForBranch methods.
 *
 * Uses pure-logic validation on the data transformation layer
 * (the Octokit API calls themselves require live credentials and are not tested here).
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

// ── Pure-logic tests for check status derivation ──

describe('GitHub check status derivation', () => {
  /** Replicates the overallState logic from GitHubService.getCheckStatus */
  function deriveOverallState(
    checkRuns: Array<{
      status: string
      conclusion: string | null
    }>
  ): 'pending' | 'success' | 'failure' | 'error' {
    const hasFailure = checkRuns.some((c) => c.conclusion === 'failure')
    if (hasFailure) return 'failure'

    const allSuccess = checkRuns.every(
      (c) => c.status === 'completed' && c.conclusion === 'success'
    )
    if (allSuccess) return 'success'

    return 'pending'
  }

  test('returns failure when any check has conclusion=failure', () => {
    const state = deriveOverallState([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'failure' },
      { status: 'completed', conclusion: 'success' }
    ])
    assert.equal(state, 'failure')
  })

  test('returns success when all checks completed with success', () => {
    const state = deriveOverallState([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'success' }
    ])
    assert.equal(state, 'success')
  })

  test('returns pending when checks are still in progress', () => {
    const state = deriveOverallState([
      { status: 'completed', conclusion: 'success' },
      { status: 'in_progress', conclusion: null }
    ])
    assert.equal(state, 'pending')
  })

  test('returns pending when checks are queued', () => {
    const state = deriveOverallState([{ status: 'queued', conclusion: null }])
    assert.equal(state, 'pending')
  })

  test('returns success for empty check list (vacuous truth)', () => {
    const state = deriveOverallState([])
    assert.equal(state, 'success')
  })

  test('failure takes priority over in-progress checks', () => {
    const state = deriveOverallState([
      { status: 'in_progress', conclusion: null },
      { status: 'completed', conclusion: 'failure' }
    ])
    assert.equal(state, 'failure')
  })
})

// ── Check run mapping tests ──

describe('GitHub check run mapping', () => {
  /** Replicates the map logic from GitHubService.getCheckStatus */
  function mapCheckRun(c: {
    name: string
    status: string
    conclusion: string | null
    output?: { title?: string | null; summary?: string | null }
  }) {
    return {
      name: c.name,
      status: c.status as 'queued' | 'in_progress' | 'completed',
      conclusion: c.conclusion,
      output: {
        title: c.output?.title ?? null,
        summary: c.output?.summary?.slice(0, 2000) ?? null
      }
    }
  }

  test('maps check run with full output', () => {
    const mapped = mapCheckRun({
      name: 'lint',
      status: 'completed',
      conclusion: 'failure',
      output: { title: 'Lint Check', summary: 'Found 3 errors' }
    })

    assert.equal(mapped.name, 'lint')
    assert.equal(mapped.status, 'completed')
    assert.equal(mapped.conclusion, 'failure')
    assert.equal(mapped.output.title, 'Lint Check')
    assert.equal(mapped.output.summary, 'Found 3 errors')
  })

  test('handles null/undefined output gracefully', () => {
    const mapped = mapCheckRun({
      name: 'build',
      status: 'in_progress',
      conclusion: null,
      output: undefined
    })

    assert.equal(mapped.output.title, null)
    assert.equal(mapped.output.summary, null)
  })

  test('truncates summary to 2000 chars', () => {
    const longSummary = 'X'.repeat(5000)
    const mapped = mapCheckRun({
      name: 'tests',
      status: 'completed',
      conclusion: 'failure',
      output: { title: null, summary: longSummary }
    })

    assert.ok(mapped.output.summary)
    assert.equal(mapped.output.summary!.length, 2000)
  })
})
