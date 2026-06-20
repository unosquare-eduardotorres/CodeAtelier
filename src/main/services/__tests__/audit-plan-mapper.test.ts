/**
 * Unit tests for auditPlanToStructuredPlan — the pure AuditPlan →
 * StructuredPlan mapper used by the Plan Hub registry. No DB or CLI touched.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { auditPlanToStructuredPlan } from '../audit-plan-mapper'
import type { AuditPlan } from '../../../shared/types'

function makeAuditPlan(overrides: Partial<AuditPlan> = {}): AuditPlan {
  return {
    version: 1,
    title: 'Fix 3 security findings',
    summary: 'Remediate XSS, CSRF, and SQL injection issues.',
    items: [
      {
        id: 'item-1',
        title: 'Sanitize HTML output',
        description: 'Escape user content in templates',
        scope: 'frontend',
        severity: 'high',
        files: ['src/renderer/template.ts'],
        recommendation: 'Use DOMPurify for sanitization',
        dependsOn: []
      },
      {
        id: 'item-2',
        title: 'Add CSRF tokens',
        description: 'Add CSRF protection middleware',
        scope: 'backend',
        severity: 'medium',
        files: ['src/main/middleware/csrf.ts', 'src/main/routes/api.ts'],
        recommendation: 'Use csurf middleware',
        dependsOn: []
      }
    ],
    risks: ['Existing forms may break without updated tokens'],
    sourceFindingIds: ['finding-1', 'finding-2', 'finding-3'],
    requirementDocument: '# Security Remediation\n...',
    ...overrides
  }
}

describe('auditPlanToStructuredPlan', () => {
  test('sets type to audit', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.type, 'audit')
  })

  test('maps title and summary directly', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.title, 'Fix 3 security findings')
    assert.equal(out.summary, 'Remediate XSS, CSRF, and SQL injection issues.')
  })

  test('maps items to phases with id, title, and description + recommendation', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.phases?.length, 2)
    const phase1 = out.phases![0]
    assert.equal(phase1.id, 1)
    assert.equal(phase1.title, 'Sanitize HTML output')
    assert.ok(phase1.description.includes('Escape user content'))
    assert.ok(phase1.description.includes('**Recommendation:** Use DOMPurify'))
  })

  test('maps severity to risk (high → high, medium → medium, low → low)', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.phases![0].risk, 'high')
    assert.equal(out.phases![1].risk, 'medium')
  })

  test('maps info/low severity to low risk', () => {
    const out = auditPlanToStructuredPlan(
      makeAuditPlan({
        items: [
          {
            id: 'i1',
            title: 'Info item',
            description: 'Minor',
            scope: 'shared',
            severity: 'info',
            files: ['a.ts'],
            recommendation: ''
          },
          {
            id: 'i2',
            title: 'Low item',
            description: 'Small',
            scope: 'shared',
            severity: 'low',
            files: ['b.ts'],
            recommendation: ''
          }
        ]
      })
    )
    assert.equal(out.phases![0].risk, 'low')
    assert.equal(out.phases![1].risk, 'low')
  })

  test('maps critical severity to high risk', () => {
    const out = auditPlanToStructuredPlan(
      makeAuditPlan({
        items: [
          {
            id: 'i1',
            title: 'Critical',
            description: 'Bad',
            scope: 'backend',
            severity: 'critical',
            files: ['a.ts'],
            recommendation: ''
          }
        ]
      })
    )
    assert.equal(out.phases![0].risk, 'high')
  })

  test('derives fileCount from item files', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.phases![0].fileCount, 1)
    assert.equal(out.phases![1].fileCount, 2)
  })

  test('collects all unique files', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.deepEqual(out.files?.sort(), [
      'src/main/middleware/csrf.ts',
      'src/main/routes/api.ts',
      'src/renderer/template.ts'
    ])
  })

  test('maps risks to medium severity', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan())
    assert.equal(out.risks?.length, 1)
    assert.equal(out.risks![0].severity, 'medium')
    assert.ok(out.risks![0].risk.includes('Existing forms may break'))
  })

  test('handles empty items gracefully', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan({ items: [] }))
    assert.equal(out.phases, undefined)
    assert.equal(out.files, undefined)
  })

  test('handles empty risks gracefully', () => {
    const out = auditPlanToStructuredPlan(makeAuditPlan({ risks: [] }))
    assert.equal(out.risks, undefined)
  })

  test('omits recommendation prefix when recommendation is empty', () => {
    const out = auditPlanToStructuredPlan(
      makeAuditPlan({
        items: [
          {
            id: 'i1',
            title: 'NoRec',
            description: 'Just a fix',
            scope: 'backend',
            files: ['x.ts'],
            recommendation: ''
          }
        ]
      })
    )
    assert.ok(!out.phases![0].description.includes('**Recommendation:**'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
