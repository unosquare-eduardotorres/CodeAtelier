/**
 * Unit tests for audit-handoff.service.ts — pure markdown formatters.
 *
 * Targets: src/main/services/audit-handoff.service.ts (27% → 80%)
 * All functions are string-in, string-out with zero side effects.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

import {
  formatDirectFindings,
  formatConsolidatedPlan,
  buildHandoffTitle
} from '../audit-handoff.service'

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeFinding(
  overrides: Partial<{
    severity: string
    title: string
    description: string
    filePath: string
    recommendation: string
  }> = {}
): any {
  return {
    severity: overrides.severity ?? 'medium',
    title: overrides.title ?? 'Test Finding',
    description: overrides.description ?? 'A test finding description',
    filePath: overrides.filePath,
    recommendation: overrides.recommendation
  }
}

function makeResult(
  overrides: Partial<{
    trackId: string
    score: number | null
    findings: any[]
    status: string
  }> = {}
): any {
  return {
    trackId: overrides.trackId ?? 'database',
    score: overrides.score !== undefined ? overrides.score : 75,
    findings: overrides.findings ?? [],
    status: overrides.status ?? 'completed'
  }
}

function makeRun(results: any[], overallScore?: number | null): any {
  return {
    results,
    overallScore: overallScore !== undefined ? overallScore : 72
  }
}

// ── formatDirectFindings ─────────────────────────────────────────────────────

describe('audit-handoff › formatDirectFindings', () => {
  test('includes track name in header', () => {
    const result = makeResult({ trackId: 'database', findings: [makeFinding()] })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('# 🔍 Audit Findings: Database'))
  })

  test('includes score and issue count', () => {
    const result = makeResult({
      score: 85,
      findings: [makeFinding({ severity: 'high' }), makeFinding({ severity: 'low' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('**Score:** 85/100'))
    assert.ok(md.includes('2 issues found'))
  })

  test('singular issue count for 1 finding', () => {
    const result = makeResult({
      findings: [makeFinding({ severity: 'critical' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('1 issue found'))
  })

  test('filters out info-severity findings', () => {
    const result = makeResult({
      findings: [
        makeFinding({ severity: 'info', title: 'Info Thing' }),
        makeFinding({ severity: 'high', title: 'Real Issue' })
      ]
    })
    const md = formatDirectFindings(result)
    assert.ok(!md.includes('Info Thing'))
    assert.ok(md.includes('Real Issue'))
    assert.ok(md.includes('1 issue found'))
  })

  test('sorts findings by severity (critical → high → medium → low)', () => {
    const result = makeResult({
      findings: [
        makeFinding({ severity: 'low', title: 'Low Issue' }),
        makeFinding({ severity: 'critical', title: 'Critical Issue' }),
        makeFinding({ severity: 'high', title: 'High Issue' }),
        makeFinding({ severity: 'medium', title: 'Medium Issue' })
      ]
    })
    const md = formatDirectFindings(result)
    const critIdx = md.indexOf('[CRITICAL]')
    const highIdx = md.indexOf('[HIGH]')
    const medIdx = md.indexOf('[MEDIUM]')
    const lowIdx = md.indexOf('[LOW]')
    assert.ok(critIdx < highIdx, 'CRITICAL before HIGH')
    assert.ok(highIdx < medIdx, 'HIGH before MEDIUM')
    assert.ok(medIdx < lowIdx, 'MEDIUM before LOW')
  })

  test('includes filePath when present', () => {
    const result = makeResult({
      findings: [makeFinding({ severity: 'high', filePath: 'src/service.ts' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('**File:** `src/service.ts`'))
  })

  test('includes recommendation when present', () => {
    const result = makeResult({
      findings: [makeFinding({ severity: 'high', recommendation: 'Add validation' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('**Recommendation:** Add validation'))
  })

  test('omits filePath and recommendation when absent', () => {
    const result = makeResult({
      findings: [makeFinding({ severity: 'high' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(!md.includes('**File:**'))
    assert.ok(!md.includes('**Recommendation:**'))
  })

  test('empty findings produces 0 issues', () => {
    const result = makeResult({ findings: [] })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('0 issues found'))
  })

  test('caps findings at MAX_FINDINGS_PER_TRACK (30)', () => {
    const findings = Array.from({ length: 35 }, (_, i) =>
      makeFinding({ severity: 'medium', title: `Issue ${i + 1}` })
    )
    const result = makeResult({ findings })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('Issue 30'))
    assert.ok(!md.includes('### 31.'))
    assert.ok(md.includes('5 more findings omitted'))
  })

  test('handles null score', () => {
    const result = makeResult({ score: null, findings: [makeFinding({ severity: 'low' })] })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('**Score:** N/A'))
  })

  test('unknown trackId falls back to raw ID', () => {
    const result = makeResult({
      trackId: 'unknown_track_xyz',
      findings: [makeFinding({ severity: 'high' })]
    })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('unknown_track_xyz'))
  })

  test('footer prompt is present', () => {
    const result = makeResult({ findings: [makeFinding({ severity: 'high' })] })
    const md = formatDirectFindings(result)
    assert.ok(md.includes('implementation plan'))
  })
})

// ── formatConsolidatedPlan ───────────────────────────────────────────────────

describe('audit-handoff › formatConsolidatedPlan', () => {
  test('includes overall score in header', () => {
    const run = makeRun([makeResult({ findings: [makeFinding({ severity: 'high' })] })], 65)
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('# 🔍 Audit Health Report — 65/100'))
  })

  test('counts total issues across tracks', () => {
    const run = makeRun([
      makeResult({
        trackId: 'database',
        findings: [makeFinding({ severity: 'high' }), makeFinding({ severity: 'medium' })]
      }),
      makeResult({ trackId: 'security', findings: [makeFinding({ severity: 'critical' })] })
    ])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('3 total issues'))
    assert.ok(md.includes('2 auditors'))
  })

  test('singular auditor count for 1 track', () => {
    const run = makeRun([makeResult({ findings: [makeFinding({ severity: 'high' })] })])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('1 auditor'))
    assert.ok(!md.includes('1 auditors'))
  })

  test('filters non-completed results', () => {
    const run = makeRun([
      makeResult({
        trackId: 'database',
        status: 'completed',
        findings: [makeFinding({ severity: 'high', title: 'DB Issue' })]
      }),
      makeResult({
        trackId: 'security',
        status: 'running',
        findings: [makeFinding({ severity: 'critical', title: 'Sec Issue' })]
      })
    ])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('DB Issue'))
    assert.ok(!md.includes('Sec Issue'))
  })

  test('filters info findings from totals', () => {
    const run = makeRun([
      makeResult({
        findings: [
          makeFinding({ severity: 'high', title: 'Real' }),
          makeFinding({ severity: 'info', title: 'FYI' })
        ]
      })
    ])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('1 total issue'))
    assert.ok(!md.includes('FYI'))
  })

  test('per-track section shows score and issue count', () => {
    const run = makeRun([
      makeResult({ trackId: 'database', score: 80, findings: [makeFinding({ severity: 'high' })] })
    ])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('Database (80/100) — 1 issue'))
  })

  test('per-track includes file path suffix', () => {
    const run = makeRun([
      makeResult({
        findings: [
          makeFinding({ severity: 'high', title: 'T', description: 'D', filePath: 'src/x.ts' })
        ]
      })
    ])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('`src/x.ts`'))
  })

  test('skips tracks with zero actionable findings', () => {
    const run = makeRun([
      makeResult({ trackId: 'database', findings: [makeFinding({ severity: 'info' })] }),
      makeResult({
        trackId: 'security',
        findings: [makeFinding({ severity: 'high', title: 'Issue' })]
      })
    ])
    const md = formatConsolidatedPlan(run)
    // Database section should be skipped (only info findings)
    assert.ok(!md.includes('## Database'))
    assert.ok(md.includes('## Security'))
  })

  test('key recommendations shows top 5 highest-severity', () => {
    const findings = [
      makeFinding({ severity: 'critical', recommendation: 'Fix critical thing' }),
      makeFinding({ severity: 'high', recommendation: 'Fix high thing' }),
      makeFinding({ severity: 'medium', title: 'Medium title no rec' })
    ]
    const run = makeRun([makeResult({ findings })])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('## Key Recommendations'))
    assert.ok(md.includes('Fix critical thing'))
    assert.ok(md.includes('Fix high thing'))
    // Falls back to title when no recommendation
    assert.ok(md.includes('Medium title no rec'))
  })

  test('handles null overall score', () => {
    const run = makeRun([makeResult({ findings: [makeFinding({ severity: 'high' })] })], null)
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('N/A'))
  })

  test('empty results array', () => {
    const run = makeRun([])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('0 total issues'))
    assert.ok(md.includes('0 auditors'))
  })

  test('footer prompt mentions synthesis', () => {
    const run = makeRun([makeResult({ findings: [makeFinding({ severity: 'high' })] })])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('synthesize an implementation plan'))
  })

  test('caps per-track findings at 30', () => {
    const findings = Array.from({ length: 35 }, (_, i) =>
      makeFinding({ severity: 'medium', title: `Finding ${i}` })
    )
    const run = makeRun([makeResult({ findings })])
    const md = formatConsolidatedPlan(run)
    assert.ok(md.includes('5 more findings'))
  })
})

// ── buildHandoffTitle ────────────────────────────────────────────────────────

describe('audit-handoff › buildHandoffTitle', () => {
  test('split mode with trackId shows track name', () => {
    const title = buildHandoffTitle('split', 'database' as any, 3)
    assert.ok(title.includes('Database'))
    assert.ok(title.includes('Fix 3 issues'))
  })

  test('split mode with 1 issue uses singular', () => {
    const title = buildHandoffTitle('split', 'database' as any, 1)
    assert.ok(title.includes('Fix 1 issue'))
    assert.ok(!title.includes('issues'))
  })

  test('consolidated mode shows Health Report', () => {
    const title = buildHandoffTitle('consolidated', undefined, 5)
    assert.ok(title.includes('Audit Health Report'))
    assert.ok(title.includes('Fix 5 issues'))
  })

  test('split mode without trackId falls back to consolidated', () => {
    const title = buildHandoffTitle('split', undefined, 3)
    assert.ok(title.includes('Audit Health Report'))
  })

  test('missing issueCount defaults to 0', () => {
    const title = buildHandoffTitle('consolidated')
    assert.ok(title.includes('Fix 0 issues'))
  })

  test('unknown trackId falls back to raw ID', () => {
    const title = buildHandoffTitle('split', 'xyz_unknown' as any, 2)
    assert.ok(title.includes('xyz_unknown'))
  })

  test('title starts with audit emoji', () => {
    const title = buildHandoffTitle('consolidated', undefined, 1)
    assert.ok(title.startsWith('🔍'))
  })
})
