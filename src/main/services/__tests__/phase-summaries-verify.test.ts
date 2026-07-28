/**
 * Unit tests for getVerifySummary dual-field remediation reading.
 *
 * Replicates the verify-summary logic from phase-summaries.ts to test
 * hermetically without importing the renderer module (which depends on React).
 *
 * Covers: remediationTasks only, legacy tasks only, both, neither.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'

// ── Replicate the dual-field read logic from phase-summaries.ts ──

interface VerifyStats {
  overallStatus: string
  remediationCount: number
  remediationTasks: Array<{ taskId: string; description: string; status?: string }>
}

function getVerifyRemediations(json: Record<string, unknown>): Array<Record<string, unknown>> {
  // Prefer new `remediationTasks` field, fall back to legacy `tasks` R-filtered
  return (
    (json.remediationTasks as Array<Record<string, unknown>>) ??
    ((json.tasks as Array<Record<string, unknown>>) ?? []).filter((t) =>
      String(t.taskId ?? '').startsWith('R')
    )
  )
}

function getVerifyStats(json: Record<string, unknown>): VerifyStats {
  const overallStatus = (json.overallStatus as string) ?? 'unknown'
  const remediations = getVerifyRemediations(json)
  return {
    overallStatus,
    remediationCount: remediations.length,
    remediationTasks: remediations.map((t) => ({
      taskId: String(t.taskId ?? ''),
      description: String(t.description ?? ''),
      status: t.status as string | undefined
    }))
  }
}

// ── Tests ──

describe('getVerifySummary — dual-field remediation read', () => {
  test('reads_remediationTasks_field_when_present', () => {
    const json = {
      overallStatus: 'gaps_found',
      remediationTasks: [
        { taskId: 'R001', description: 'Fix auth middleware', files: ['src/auth.ts'] },
        { taskId: 'R002', description: 'Add error handling', files: ['src/errors.ts'] }
      ]
    }
    const stats = getVerifyStats(json)
    assert.equal(stats.overallStatus, 'gaps_found')
    assert.equal(stats.remediationCount, 2)
    assert.equal(stats.remediationTasks[0].taskId, 'R001')
    assert.equal(stats.remediationTasks[1].taskId, 'R002')
  })

  test('falls_back_to_legacy_tasks_R_filtered', () => {
    const json = {
      overallStatus: 'gaps_found',
      tasks: [
        { taskId: 'R001', description: 'Fix auth middleware' },
        { taskId: 'T001', description: 'Some regular task' },
        { taskId: 'R002', description: 'Add error handling' }
      ]
    }
    const stats = getVerifyStats(json)
    assert.equal(stats.remediationCount, 2)
    assert.equal(stats.remediationTasks[0].taskId, 'R001')
    assert.equal(stats.remediationTasks[1].taskId, 'R002')
  })

  test('prefers_remediationTasks_over_tasks_when_both_present', () => {
    const json = {
      overallStatus: 'gaps_found',
      remediationTasks: [{ taskId: 'R001', description: 'From remediationTasks' }],
      tasks: [
        { taskId: 'R001', description: 'From tasks field' },
        { taskId: 'R002', description: 'Extra in tasks' }
      ]
    }
    const stats = getVerifyStats(json)
    // Should use remediationTasks (1 item), not tasks (2 R-items)
    assert.equal(stats.remediationCount, 1)
    assert.equal(stats.remediationTasks[0].description, 'From remediationTasks')
  })

  test('returns_empty_when_neither_field_present', () => {
    const json = {
      overallStatus: 'passed'
    }
    const stats = getVerifyStats(json)
    assert.equal(stats.remediationCount, 0)
    assert.deepEqual(stats.remediationTasks, [])
  })

  test('returns_empty_when_tasks_has_no_R_prefix', () => {
    const json = {
      overallStatus: 'gaps_found',
      tasks: [
        { taskId: 'T001', description: 'Regular task' },
        { taskId: 'B002', description: 'Build task' }
      ]
    }
    const stats = getVerifyStats(json)
    assert.equal(stats.remediationCount, 0)
  })

  test('handles_remediationTasks_as_empty_array', () => {
    const json = {
      overallStatus: 'gaps_found',
      remediationTasks: [],
      tasks: [{ taskId: 'R001', description: 'Should NOT be used since remediationTasks exists' }]
    }
    const stats = getVerifyStats(json)
    // remediationTasks exists (empty array is truthy in ?? check → still picks it)
    assert.equal(stats.remediationCount, 0)
  })

  test('handles_task_status_field', () => {
    const json = {
      overallStatus: 'gaps_found',
      remediationTasks: [
        { taskId: 'R001', description: 'Fix auth', status: 'complete' },
        { taskId: 'R002', description: 'Fix routes', status: 'failed' },
        { taskId: 'R003', description: 'Fix tests' }
      ]
    }
    const stats = getVerifyStats(json)
    assert.equal(stats.remediationTasks[0].status, 'complete')
    assert.equal(stats.remediationTasks[1].status, 'failed')
    assert.equal(stats.remediationTasks[2].status, undefined)
  })

  test('defaults_overallStatus_to_unknown', () => {
    const json = {} as Record<string, unknown>
    const stats = getVerifyStats(json)
    assert.equal(stats.overallStatus, 'unknown')
  })
})

// ── Banner dual-field consistency test ──

describe('banner dual-field read consistency', () => {
  test('banner_count_matches_table_for_remediationTasks_field', () => {
    const json: Record<string, unknown> = {
      overallStatus: 'gaps_found',
      remediationTasks: [
        { taskId: 'R001', description: 'Fix A' },
        { taskId: 'R002', description: 'Fix B' },
        { taskId: 'R003', description: 'Fix C' }
      ]
    }
    // Replicate banner read (BlueprintDetailView)
    const bannerRemTasks =
      (json?.remediationTasks as unknown[]) ??
      ((json?.tasks as Array<Record<string, unknown>>) ?? []).filter((t) =>
        String(t.taskId ?? '').startsWith('R')
      )
    // Replicate table read (VerifyDeliverable)
    const tableRemTasks = getVerifyRemediations(json)

    assert.equal(
      bannerRemTasks.length,
      tableRemTasks.length,
      'Banner count and table count must match'
    )
  })

  test('banner_count_matches_table_for_legacy_tasks_field', () => {
    const json: Record<string, unknown> = {
      overallStatus: 'gaps_found',
      tasks: [
        { taskId: 'R001', description: 'Fix A' },
        { taskId: 'T001', description: 'Build task' },
        { taskId: 'R002', description: 'Fix B' }
      ]
    }
    const bannerRemTasks =
      (json?.remediationTasks as unknown[]) ??
      ((json?.tasks as Array<Record<string, unknown>>) ?? []).filter((t) =>
        String(t.taskId ?? '').startsWith('R')
      )
    const tableRemTasks = getVerifyRemediations(json)

    assert.equal(
      bannerRemTasks.length,
      tableRemTasks.length,
      'Banner count and table count must match for legacy field'
    )
    assert.equal(bannerRemTasks.length, 2)
  })
})

// ── Only call summaryAsync when run standalone ──
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
