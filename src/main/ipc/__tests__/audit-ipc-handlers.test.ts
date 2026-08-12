/**
 * Tests for pure-logic functions extracted from audit.ipc.ts.
 *
 * No Electron mocks needed — all functions operate on plain data.
 *
 * Run: tsx src/main/ipc/__tests__/audit-ipc-handlers.test.ts
 */

import assert from 'node:assert/strict'
import { test, describe, summary } from '../../services/__tests__/test-harness'
import {
  computeAuditOverallScore,
  computeStaleAuditReconciliation,
  generateAuditReportMarkdown,
  generateRemediationPlanMarkdown,
  formatFindingsAsContext
} from '../audit-ipc-handlers'
import type {
  AuditResult,
  AuditRun,
  AuditFinding,
  AuditPlan,
  AuditTrackId
} from '../../../shared/types'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<AuditResult> & { trackId: AuditTrackId }): AuditResult {
  return {
    id: `result-${overrides.trackId}`,
    auditRunId: 'run-1',
    score: null,
    status: 'pending',
    findings: [],
    summary: '',
    skillsUsed: [],
    startedAt: null,
    completedAt: null,
    ...overrides
  }
}

function makeRun(overrides?: Partial<AuditRun>): AuditRun {
  return {
    id: 'run-1',
    workspaceId: 'ws-1',
    mode: 'light',
    status: 'completed',
    overallScore: null,
    selectedTracks: ['code', 'testing'],
    detectedTechs: ['typescript'],
    results: [],
    createdAt: '2025-06-01T12:00:00.000Z',
    updatedAt: '2025-06-01T12:30:00.000Z',
    ...overrides
  }
}

function makeFinding(overrides?: Partial<AuditFinding>): AuditFinding {
  return {
    id: 'f-1',
    severity: 'medium',
    title: 'Test finding',
    description: 'A test finding description',
    ...overrides
  }
}

function makePlan(overrides?: Partial<AuditPlan>): AuditPlan {
  return {
    version: 1,
    title: 'Remediation Plan',
    summary: 'Fix the issues found.',
    items: [],
    risks: [],
    sourceFindingIds: [],
    requirementDocument: '',
    ...overrides
  }
}

// ── computeAuditOverallScore ─────────────────────────────────────────────────

describe('computeAuditOverallScore', () => {
  test('computes weighted average from all-completed results', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 80, coverageSufficient: true }),
      makeResult({ trackId: 'testing', status: 'completed', score: 60, coverageSufficient: true })
    ]
    // code weight=1.5, testing weight=1.0 → (80*1.5 + 60*1.0) / (1.5+1.0) = 180/2.5 = 72
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 72)
    assert.equal(result.status, 'completed')
  })

  test('returns partial status when any track failed', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 90, coverageSufficient: true }),
      makeResult({ trackId: 'testing', status: 'failed', score: null })
    ]
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 90)
    assert.equal(result.status, 'partial')
  })

  test('excludes tracks with insufficient coverage', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 80, coverageSufficient: true }),
      makeResult({ trackId: 'testing', status: 'completed', score: 20, coverageSufficient: false })
    ]
    const result = computeAuditOverallScore(results)
    // Only code counts → 80
    assert.equal(result.overallScore, 80)
    assert.equal(result.status, 'completed')
  })

  test('returns null score when no completed results', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'pending', score: null }),
      makeResult({ trackId: 'testing', status: 'running', score: null })
    ]
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, null)
    assert.equal(result.status, 'completed')
  })

  test('returns null score for empty results array', () => {
    const result = computeAuditOverallScore([])
    assert.equal(result.overallScore, null)
    assert.equal(result.status, 'completed')
  })

  test('handles single completed track', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'database', status: 'completed', score: 75, coverageSufficient: true })
    ]
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 75)
    assert.equal(result.status, 'completed')
  })

  test('excludes results with null score even if completed', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: null, coverageSufficient: true }),
      makeResult({ trackId: 'testing', status: 'completed', score: 70, coverageSufficient: true })
    ]
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 70)
  })

  test('treats undefined coverageSufficient as sufficient', () => {
    const results: AuditResult[] = [makeResult({ trackId: 'code', status: 'completed', score: 85 })]
    // coverageSufficient is undefined → should still be included
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 85)
  })

  test('rounds weighted average to nearest integer', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 71, coverageSufficient: true }),
      makeResult({ trackId: 'database', status: 'completed', score: 82, coverageSufficient: true })
    ]
    // code weight=1.5, database weight=1.0 → (71*1.5 + 82*1.0) / (1.5+1.0) = 188.5/2.5 = 75.4 → 75
    const result = computeAuditOverallScore(results)
    assert.equal(result.overallScore, 75)
  })
})

// ── computeStaleAuditReconciliation ──────────────────────────────────────────

describe('computeStaleAuditReconciliation', () => {
  test('cancels running and pending results', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'running' }),
      makeResult({ trackId: 'testing', status: 'pending' }),
      makeResult({ trackId: 'database', status: 'completed', score: 80 })
    ]
    const rec = computeStaleAuditReconciliation(results)
    assert.deepEqual(rec.resultIdsToCancel.sort(), ['result-code', 'result-testing'])
    assert.equal(rec.finalStatus, 'partial')
  })

  test('returns cancelled status when no tracks completed', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'running' }),
      makeResult({ trackId: 'testing', status: 'pending' })
    ]
    const rec = computeStaleAuditReconciliation(results)
    assert.equal(rec.finalStatus, 'cancelled')
    assert.equal(rec.resultIdsToCancel.length, 2)
  })

  test('returns partial when some tracks completed and some not', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 90 }),
      makeResult({ trackId: 'testing', status: 'running' })
    ]
    const rec = computeStaleAuditReconciliation(results)
    assert.deepEqual(rec.resultIdsToCancel, ['result-testing'])
    assert.equal(rec.finalStatus, 'partial')
  })

  test('returns empty cancel list when all already completed', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'completed', score: 80 }),
      makeResult({ trackId: 'testing', status: 'completed', score: 70 })
    ]
    const rec = computeStaleAuditReconciliation(results)
    assert.equal(rec.resultIdsToCancel.length, 0)
    assert.equal(rec.finalStatus, 'partial') // hasCompleted=true → 'partial'
  })

  test('handles empty results array', () => {
    const rec = computeStaleAuditReconciliation([])
    assert.equal(rec.resultIdsToCancel.length, 0)
    assert.equal(rec.finalStatus, 'cancelled')
  })

  test('preserves failed tracks (does not cancel them)', () => {
    const results: AuditResult[] = [
      makeResult({ trackId: 'code', status: 'failed' }),
      makeResult({ trackId: 'testing', status: 'pending' })
    ]
    const rec = computeStaleAuditReconciliation(results)
    assert.deepEqual(rec.resultIdsToCancel, ['result-testing'])
    assert.equal(rec.finalStatus, 'cancelled')
  })
})

// ── generateAuditReportMarkdown ──────────────────────────────────────────────

describe('generateAuditReportMarkdown', () => {
  test('generates report with multiple tracks and findings', () => {
    const run = makeRun({
      selectedTracks: ['code', 'testing'],
      overallScore: 75,
      results: [
        makeResult({
          trackId: 'code',
          status: 'completed',
          score: 80,
          summary: 'Good code quality',
          findings: [
            makeFinding({
              severity: 'high',
              title: 'N+1 query',
              filePath: 'src/db.ts',
              recommendation: 'Use eager loading'
            })
          ]
        }),
        makeResult({
          trackId: 'testing',
          status: 'completed',
          score: 60,
          summary: 'Needs more tests',
          findings: []
        })
      ]
    })

    const md = generateAuditReportMarkdown(run, 'MyProject')

    assert.ok(md.includes('# Workspace Health Report'))
    assert.ok(md.includes('**Workspace:** MyProject'))
    assert.ok(md.includes('**Mode:** Light'))
    assert.ok(md.includes('**Overall Score:** 75/100'))
    assert.ok(md.includes('## Code Quality — 80/100'))
    assert.ok(md.includes('Good code quality'))
    assert.ok(md.includes('### Findings'))
    assert.ok(md.includes('| HIGH | N+1 query | src/db.ts | Use eager loading |'))
    assert.ok(md.includes('## Testing — 60/100'))
    assert.ok(md.includes('Needs more tests'))
  })

  test('handles null overall score with em dash', () => {
    const run = makeRun({ overallScore: null, results: [] })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(md.includes('**Overall Score:** —/100'))
  })

  test('handles null result score with em dash', () => {
    const run = makeRun({
      selectedTracks: ['code'],
      results: [makeResult({ trackId: 'code', score: null })]
    })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(md.includes('— —/100'))
  })

  test('handles empty results array', () => {
    const run = makeRun({ selectedTracks: ['code'], results: [] })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(md.includes('# Workspace Health Report'))
    // Should not have any track sections
    assert.ok(!md.includes('## Code Quality'))
  })

  test('skips findings table when findings are empty', () => {
    const run = makeRun({
      selectedTracks: ['code'],
      results: [makeResult({ trackId: 'code', status: 'completed', score: 90, findings: [] })]
    })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(!md.includes('### Findings'))
    assert.ok(!md.includes('| Severity |'))
  })

  test('uses Deep mode label', () => {
    const run = makeRun({ mode: 'deep' as 'light', results: [] })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(md.includes('**Mode:** Deep'))
  })

  test('handles finding with missing optional fields', () => {
    const run = makeRun({
      selectedTracks: ['code'],
      results: [
        makeResult({
          trackId: 'code',
          status: 'completed',
          score: 70,
          findings: [makeFinding({ filePath: undefined, recommendation: undefined })]
        })
      ]
    })
    const md = generateAuditReportMarkdown(run, 'Test')
    assert.ok(md.includes('| — | — |'))
  })
})

// ── generateRemediationPlanMarkdown ──────────────────────────────────────────

describe('generateRemediationPlanMarkdown', () => {
  test('generates full plan with items, files, dependencies, and risks', () => {
    const plan = makePlan({
      title: 'Fix All The Things',
      summary: 'Address 3 critical issues.',
      sourceFindingIds: ['f-1', 'f-2', 'f-3'],
      items: [
        {
          id: 'item-1',
          title: 'Fix N+1 query',
          description: 'Refactor the DB layer.',
          scope: 'backend',
          severity: 'high',
          files: ['src/db.ts', 'src/repo.ts'],
          recommendation: 'Use eager loading',
          dependsOn: ['item-2']
        },
        {
          id: 'item-2',
          title: 'Add indexes',
          description: 'Add missing database indexes.',
          scope: 'database',
          files: [],
          recommendation: 'Run migration',
          dependsOn: undefined
        }
      ],
      risks: ['Downtime during migration', 'Data loss if rollback fails']
    })

    const md = generateRemediationPlanMarkdown(plan, 'MyProject', '2025-06-01T12:00:00.000Z')

    assert.ok(md.includes('# Fix All The Things'))
    assert.ok(md.includes('**Workspace:** MyProject'))
    assert.ok(md.includes('**Items:** 2'))
    assert.ok(md.includes('**Findings addressed:** 3'))
    assert.ok(md.includes('Address 3 critical issues.'))
    assert.ok(md.includes('## 1. Fix N+1 query `HIGH`'))
    assert.ok(md.includes('**Scope:** backend'))
    assert.ok(md.includes('Refactor the DB layer.'))
    assert.ok(md.includes('> 💡 Use eager loading'))
    assert.ok(md.includes('`src/db.ts`'))
    assert.ok(md.includes('`src/repo.ts`'))
    assert.ok(md.includes('**Depends on:** item-2'))
    assert.ok(md.includes('## 2. Add indexes'))
    assert.ok(md.includes('## ⚠️ Risks'))
    assert.ok(md.includes('- Downtime during migration'))
    assert.ok(md.includes('- Data loss if rollback fails'))
  })

  test('omits severity tag when not set', () => {
    const plan = makePlan({
      items: [
        {
          id: 'item-1',
          title: 'Generic fix',
          description: 'Do it.',
          scope: 'shared',
          files: [],
          recommendation: ''
        }
      ]
    })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(md.includes('## 1. Generic fix'))
    assert.ok(!md.includes('`UNDEFINED`'))
  })

  test('omits risk section when no risks', () => {
    const plan = makePlan({ risks: [] })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(!md.includes('## ⚠️ Risks'))
  })

  test('omits files section when no files', () => {
    const plan = makePlan({
      items: [
        {
          id: 'item-1',
          title: 'Fix',
          description: 'Desc',
          scope: 'backend',
          files: [],
          recommendation: 'Rec'
        }
      ]
    })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(!md.includes('**Files:**'))
  })

  test('omits recommendation when empty', () => {
    const plan = makePlan({
      items: [
        {
          id: 'item-1',
          title: 'Fix',
          description: 'Desc',
          scope: 'backend',
          files: [],
          recommendation: ''
        }
      ]
    })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(!md.includes('> 💡'))
  })

  test('handles empty items array', () => {
    const plan = makePlan({ items: [] })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(md.includes('**Items:** 0'))
    assert.ok(!md.includes('## 1.'))
  })

  test('omits dependsOn when empty array', () => {
    const plan = makePlan({
      items: [
        {
          id: 'item-1',
          title: 'Fix',
          description: 'Desc',
          scope: 'backend',
          files: [],
          recommendation: '',
          dependsOn: []
        }
      ]
    })
    const md = generateRemediationPlanMarkdown(plan, 'Test', '2025-01-01T00:00:00Z')
    assert.ok(!md.includes('**Depends on:**'))
  })
})

// ── formatFindingsAsContext ───────────────────────────────────────────────────

describe('formatFindingsAsContext', () => {
  test('formats findings with all fields', () => {
    const findings: AuditFinding[] = [
      makeFinding({
        severity: 'high',
        title: 'SQL Injection',
        description: 'User input not sanitized.',
        filePath: 'src/api.ts',
        recommendation: 'Use parameterized queries'
      }),
      makeFinding({
        severity: 'low',
        title: 'Console log',
        description: 'Debug logging left in.',
        filePath: 'src/util.ts',
        recommendation: 'Remove before prod'
      })
    ]

    const ctx = formatFindingsAsContext(findings)

    assert.ok(ctx.includes('### 1. [HIGH] SQL Injection'))
    assert.ok(ctx.includes('User input not sanitized.'))
    assert.ok(ctx.includes('**File:** `src/api.ts`'))
    assert.ok(ctx.includes('**Recommendation:** Use parameterized queries'))
    assert.ok(ctx.includes('### 2. [LOW] Console log'))
  })

  test('omits file when not present', () => {
    const findings: AuditFinding[] = [makeFinding({ filePath: undefined })]
    const ctx = formatFindingsAsContext(findings)
    assert.ok(!ctx.includes('**File:**'))
  })

  test('omits recommendation when not present', () => {
    const findings: AuditFinding[] = [makeFinding({ recommendation: undefined })]
    const ctx = formatFindingsAsContext(findings)
    assert.ok(!ctx.includes('**Recommendation:**'))
  })

  test('returns empty string for empty array', () => {
    const ctx = formatFindingsAsContext([])
    assert.equal(ctx, '')
  })

  test('handles single finding', () => {
    const findings: AuditFinding[] = [makeFinding({ severity: 'critical', title: 'CVE-2025-001' })]
    const ctx = formatFindingsAsContext(findings)
    assert.ok(ctx.includes('### 1. [CRITICAL] CVE-2025-001'))
    // No separator before/after single item
    assert.ok(!ctx.includes('### 2.'))
  })

  test('separates findings with double newline', () => {
    const findings: AuditFinding[] = [makeFinding({ id: 'f-1' }), makeFinding({ id: 'f-2' })]
    const ctx = formatFindingsAsContext(findings)
    assert.ok(ctx.includes('\n\n###'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  summary()
}
