/**
 * Audit → Blueprint handoff — the pure formatting the conversion depends on.
 *
 * A blueprint created from findings only ever sees the markdown produced here:
 * the Specify phase reads it as the requirement, so a dropped file path or
 * recommendation is invisible for the rest of the pipeline. Priority matters
 * for the same reason — it is what schedules the blueprint against the others.
 *
 * Run: tsx src/main/services/__tests__/audit-blueprint-handoff.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  buildAuditBlueprintTitle,
  deriveBlueprintPriority,
  formatAuditFindingsBrief
} from '../../../shared/audit-blueprint-format'
import type { AuditFinding } from '../../../shared/types'

function finding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    id: 'f1',
    severity: 'medium',
    title: 'Unvalidated IPC argument',
    description: 'The handler reads args.workspaceId without checking its type.',
    ...overrides
  }
}

describe('deriveBlueprintPriority', () => {
  test('one critical finding makes the whole batch P1', () => {
    const priority = deriveBlueprintPriority([
      finding({ id: 'a', severity: 'low' }),
      finding({ id: 'b', severity: 'critical' }),
      finding({ id: 'c', severity: 'info' })
    ])
    assert.equal(priority, 'P1')
  })

  test('high without critical is P2', () => {
    assert.equal(
      deriveBlueprintPriority([finding({ severity: 'high' }), finding({ severity: 'medium' })]),
      'P2'
    )
  })

  test('anything milder falls back to P3', () => {
    assert.equal(deriveBlueprintPriority([finding({ severity: 'medium' })]), 'P3')
    assert.equal(deriveBlueprintPriority([]), 'P3')
  })
})

describe('buildAuditBlueprintTitle', () => {
  test('singular and plural', () => {
    assert.equal(buildAuditBlueprintTitle([finding()]), 'Audit remediation: 1 finding')
    assert.equal(
      buildAuditBlueprintTitle([finding({ id: 'a' }), finding({ id: 'b' })]),
      'Audit remediation: 2 findings'
    )
  })

  test('stays free of emoji and newlines so it can seed a branch name', () => {
    const title = buildAuditBlueprintTitle([finding()])
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(title))
    assert.ok(!title.includes('\n'))
  })
})

describe('formatAuditFindingsBrief', () => {
  const findings = [
    finding({ id: 'low', severity: 'low', title: 'Missing JSDoc' }),
    finding({
      id: 'crit',
      severity: 'critical',
      title: 'SQL built by concatenation',
      filePath: 'src/main/db/index.ts',
      recommendation: 'Use a prepared statement.'
    }),
    finding({ id: 'med', severity: 'medium', title: 'Unhandled rejection' })
  ]

  test('orders findings worst severity first', () => {
    const md = formatAuditFindingsBrief(findings)
    const crit = md.indexOf('SQL built by concatenation')
    const med = md.indexOf('Unhandled rejection')
    const low = md.indexOf('Missing JSDoc')
    assert.ok(crit < med, 'critical must precede medium')
    assert.ok(med < low, 'medium must precede low')
  })

  test('carries severity, description, file and recommendation for every finding', () => {
    const md = formatAuditFindingsBrief(findings)
    for (const f of findings) {
      assert.ok(md.includes(f.title), `missing title: ${f.title}`)
      assert.ok(md.includes(f.description), `missing description for ${f.title}`)
      assert.ok(md.includes(`[${f.severity.toUpperCase()}]`), `missing severity for ${f.title}`)
    }
    assert.ok(md.includes('src/main/db/index.ts'))
    assert.ok(md.includes('Use a prepared statement.'))
  })

  test('lists the distinct files in scope', () => {
    const md = formatAuditFindingsBrief([
      finding({ id: 'a', filePath: 'src/a.ts' }),
      finding({ id: 'b', filePath: 'src/a.ts' }),
      finding({ id: 'c', filePath: 'src/b.ts' })
    ])
    const section = md.slice(md.indexOf('### Files in scope'))
    assert.equal(section.match(/`src\/a\.ts`/g)?.length, 1, 'duplicate file paths must collapse')
    assert.ok(section.includes('`src/b.ts`'))
  })

  test('omits the files section when no finding names a file', () => {
    assert.ok(!formatAuditFindingsBrief([finding()]).includes('Files in scope'))
  })

  test('names the source run when one is supplied', () => {
    assert.ok(formatAuditFindingsBrief([finding()], { auditRunId: 'run-9' }).includes('run-9'))
    assert.ok(!formatAuditFindingsBrief([finding()]).includes('run-9'))
  })

  test('does not mutate the caller array while sorting', () => {
    const input = [
      finding({ id: 'low', severity: 'low' }),
      finding({ id: 'crit', severity: 'critical' })
    ]
    formatAuditFindingsBrief(input)
    assert.equal(input[0].id, 'low')
  })
})

// summaryAsync() calls process.exit(), so it must only run when this file is the
// entry point — unguarded it terminates the shared runner mid-list and every
// file registered after this one silently never executes.
if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
