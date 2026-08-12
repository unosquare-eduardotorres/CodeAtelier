/**
 * Unit tests for Audit Agent service pure functions — track selection,
 * score aggregation, status computation, config helpers.
 *
 * Phase 14, Track 8b — audit-agent.service.ts (~830 lines at ~19%)
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { AUDIT_TRACKS } from '../../../shared/constants'

// ── Replicated pure logic from AuditAgentService ──

/**
 * Replicated from AuditAgentService.isRetryableError (audit-agent.service.ts:306-317).
 */
function isRetryableError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase()
  return (
    msg.includes('400') ||
    msg.includes('empty thinking') ||
    msg.includes('invalid_request_error') ||
    msg.includes('overloaded') ||
    msg.includes('529') ||
    msg.includes('rate_limit') ||
    msg.includes('timeout')
  )
}

/**
 * Replicated from AuditAgentService.isApiErrorText (audit-agent.service.ts:740-747).
 */
function isApiErrorText(text: string): boolean {
  return (
    text.includes('API Error:') ||
    text.includes('"type":"error"') ||
    text.includes('invalid_request_error') ||
    text.includes('each thinking block must contain')
  )
}

/**
 * Replicated from AuditAgentService.getBatchSize (audit-agent.service.ts:749-751).
 */
function getBatchSize(isLocal: boolean): number {
  return isLocal ? 3 : 12
}

/**
 * Replicated from AuditAgentService.getMaxRounds (audit-agent.service.ts:753-755).
 */
function getMaxRounds(isLocal: boolean): number {
  return isLocal ? 15 : 5
}

/**
 * Replicated from AuditAgentService.summarizePreviousFindings (audit-agent.service.ts:776-784).
 */
function summarizePreviousFindings(
  findings: Array<{ severity: string; title: string; filePath?: string }>
): string {
  if (findings.length === 0) return 'No findings yet.'
  return findings
    .slice(-10)
    .map((f) => `- [${f.severity.toUpperCase()}] ${f.title}${f.filePath ? ` (${f.filePath})` : ''}`)
    .join('\n')
}

/**
 * Replicated from AuditAgentService.hasAdequateCoverage (audit-agent.service.ts:786-796).
 */
function hasAdequateCoverage(findingCount: number, fileCount: number, totalFiles: number): boolean {
  const coveragePercent = totalFiles > 0 ? fileCount / totalFiles : 0
  const hasEnoughFindings = findingCount >= 8
  const hasEnoughCoverage = coveragePercent >= 0.6
  return hasEnoughFindings && hasEnoughCoverage
}

/**
 * Replicated from audit-agent.service.ts calculateOverallScore (lines 808-827).
 */
function calculateOverallScore(
  results: Array<{ status: string; score: number; coverageSufficient: boolean; trackId: string }>,
  tracks: Record<string, { weight: number }>
): number | null {
  const eligible = results.filter((r) => r.status === 'completed' && r.coverageSufficient !== false)
  if (eligible.length === 0) return null

  let weightedSum = 0
  let totalWeight = 0
  for (const result of eligible) {
    const track = tracks[result.trackId]
    const weight = track?.weight ?? 1
    weightedSum += result.score * weight
    totalWeight += weight
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : null
}

/**
 * Replicated audit status computation.
 */
type AuditStatus = 'pending' | 'running' | 'scored' | 'failed'

function computeAuditStatus(trackStatuses: AuditStatus[]): AuditStatus {
  if (trackStatuses.every((s) => s === 'scored')) return 'scored'
  if (trackStatuses.some((s) => s === 'running')) return 'running'
  if (trackStatuses.every((s) => s === 'failed')) return 'failed'
  return 'pending'
}

// ── Tests ──

describe('Audit — track selection', () => {
  test('AUDIT_TRACKS_contains_expected_tracks', () => {
    const trackIds = Object.keys(AUDIT_TRACKS)
    assert.ok(trackIds.length >= 5)
    assert.ok(trackIds.includes('architecture'))
    assert.ok(trackIds.includes('security'))
    assert.ok(trackIds.includes('testing'))
  })

  test('each_track_has_name_and_weight', () => {
    for (const [id, track] of Object.entries(AUDIT_TRACKS)) {
      assert.ok((track as any).name, `Track ${id} missing name`)
      assert.ok(typeof (track as any).weight === 'number', `Track ${id} missing weight`)
    }
  })
})

describe('Audit — isRetryableError', () => {
  test('rate_limit_is_retryable', () => {
    assert.ok(isRetryableError('rate_limit exceeded'))
  })

  test('timeout_is_retryable', () => {
    assert.ok(isRetryableError('Request timeout after 30s'))
  })

  test('400_is_retryable', () => {
    assert.ok(isRetryableError('HTTP 400 Bad Request'))
  })

  test('529_is_retryable', () => {
    assert.ok(isRetryableError('HTTP 529 Site is overloaded'))
  })

  test('overloaded_is_retryable', () => {
    assert.ok(isRetryableError('Server overloaded'))
  })

  test('unknown_error_is_not_retryable', () => {
    assert.ok(!isRetryableError('Permission denied'))
  })

  test('empty_message_is_not_retryable', () => {
    assert.ok(!isRetryableError(''))
  })
})

describe('Audit — isApiErrorText', () => {
  test('API_Error_prefix_detected', () => {
    assert.ok(isApiErrorText('API Error: invalid key'))
  })

  test('error_JSON_pattern_detected', () => {
    assert.ok(isApiErrorText('{"type":"error","message":"bad"}'))
  })

  test('invalid_request_error_detected', () => {
    assert.ok(isApiErrorText('invalid_request_error: missing field'))
  })

  test('regular_text_not_detected', () => {
    assert.ok(!isApiErrorText('The code review looks good overall'))
  })
})

describe('Audit — session configuration', () => {
  test('local_batch_size_is_3', () => {
    assert.equal(getBatchSize(true), 3)
  })

  test('cloud_batch_size_is_12', () => {
    assert.equal(getBatchSize(false), 12)
  })

  test('local_max_rounds_is_15', () => {
    assert.equal(getMaxRounds(true), 15)
  })

  test('cloud_max_rounds_is_5', () => {
    assert.equal(getMaxRounds(false), 5)
  })
})

describe('Audit — summarizePreviousFindings', () => {
  test('empty_findings_returns_no_findings_message', () => {
    assert.equal(summarizePreviousFindings([]), 'No findings yet.')
  })

  test('findings_formatted_as_bullet_list', () => {
    const findings = [
      { severity: 'high', title: 'SQL injection risk', filePath: 'src/db.ts' },
      { severity: 'medium', title: 'Missing validation' }
    ]
    const result = summarizePreviousFindings(findings)
    assert.ok(result.includes('- [HIGH] SQL injection risk (src/db.ts)'))
    assert.ok(result.includes('- [MEDIUM] Missing validation'))
  })

  test('more_than_10_findings_takes_last_10', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      severity: 'low',
      title: `Finding ${i}`,
      filePath: `file${i}.ts`
    }))
    const result = summarizePreviousFindings(findings)
    // Should contain findings 5-14 (last 10)
    assert.ok(result.includes('Finding 5'))
    assert.ok(result.includes('Finding 14'))
    assert.ok(!result.includes('Finding 4'))
  })

  test('findings_without_filePath_omit_parenthetical', () => {
    const result = summarizePreviousFindings([{ severity: 'info', title: 'General observation' }])
    assert.ok(!result.includes('('))
    assert.ok(result.includes('- [INFO] General observation'))
  })
})

describe('Audit — hasAdequateCoverage', () => {
  test('8_findings_60_percent_returns_true', () => {
    assert.ok(hasAdequateCoverage(8, 6, 10))
  })

  test('7_findings_70_percent_returns_false', () => {
    assert.ok(!hasAdequateCoverage(7, 7, 10))
  })

  test('10_findings_50_percent_returns_false', () => {
    assert.ok(!hasAdequateCoverage(10, 5, 10))
  })

  test('0_total_files_returns_false', () => {
    assert.ok(!hasAdequateCoverage(8, 0, 0))
  })

  test('both_thresholds_met_returns_true', () => {
    assert.ok(hasAdequateCoverage(10, 8, 10))
  })
})

describe('Audit — calculateOverallScore', () => {
  test('weighted_average_calculation', () => {
    const results = [
      { status: 'completed', score: 80, coverageSufficient: true, trackId: 'architecture' },
      { status: 'completed', score: 60, coverageSufficient: true, trackId: 'security' }
    ]
    const tracks = { architecture: { weight: 2 }, security: { weight: 1 } }
    const score = calculateOverallScore(results, tracks)
    // (80*2 + 60*1) / (2+1) = 220/3 = 73.33 → 73
    assert.equal(score, 73)
  })

  test('insufficient_coverage_excluded', () => {
    const results = [
      { status: 'completed', score: 80, coverageSufficient: true, trackId: 'architecture' },
      { status: 'completed', score: 20, coverageSufficient: false, trackId: 'security' }
    ]
    const tracks = { architecture: { weight: 1 }, security: { weight: 1 } }
    const score = calculateOverallScore(results, tracks)
    assert.equal(score, 80) // Only architecture counts
  })

  test('all_insufficient_returns_null', () => {
    const results = [{ status: 'completed', score: 50, coverageSufficient: false, trackId: 'a' }]
    assert.equal(calculateOverallScore(results, { a: { weight: 1 } }), null)
  })

  test('empty_results_returns_null', () => {
    assert.equal(calculateOverallScore([], {}), null)
  })
})

describe('Audit — status computation', () => {
  test('all_scored_returns_scored', () => {
    assert.equal(computeAuditStatus(['scored', 'scored', 'scored']), 'scored')
  })

  test('some_running_returns_running', () => {
    assert.equal(computeAuditStatus(['scored', 'running', 'pending']), 'running')
  })

  test('all_failed_returns_failed', () => {
    assert.equal(computeAuditStatus(['failed', 'failed']), 'failed')
  })

  test('all_pending_returns_pending', () => {
    assert.equal(computeAuditStatus(['pending', 'pending']), 'pending')
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
