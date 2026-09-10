/**
 * design-blueprint-format tests — routing table, priority mapping, brief
 * structure, and title building for the Design → Blueprint handoff (P6.1).
 *
 * Pure functions; no mocks needed.
 *
 * Run: tsx src/shared/__tests__/design-blueprint-format.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'

import {
  buildDesignBlueprintTitle,
  classifyFinding,
  deriveBlueprintPriority,
  formatDesignRemediationBrief,
  CLUSTER_COMMANDS
} from '../design-blueprint-format'
import type { AuditFinding } from '../types'

function finding(partial: Partial<AuditFinding>): AuditFinding {
  return {
    id: partial.id ?? 'f1',
    severity: partial.severity ?? 'medium',
    title: partial.title ?? 'Finding',
    description: partial.description ?? 'A finding.',
    ...partial
  }
}

const BASE = {
  brief: 'Make the settings page feel less generic',
  commandIds: ['audit', 'polish'],
  scopeLabel: 'src/renderer'
}

describe('design-blueprint-format', () => {
  describe('deriveBlueprintPriority', () => {
    test('one critical makes the batch P1', () => {
      assert.equal(
        deriveBlueprintPriority([finding({ severity: 'low' }), finding({ severity: 'critical' })]),
        'P1'
      )
    })
    test('high without critical is P2', () => {
      assert.equal(deriveBlueprintPriority([finding({ severity: 'high' })]), 'P2')
    })
    test('anything milder is P3', () => {
      assert.equal(
        deriveBlueprintPriority([finding({ severity: 'medium' }), finding({ severity: 'info' })]),
        'P3'
      )
    })
  })

  describe('buildDesignBlueprintTitle', () => {
    test('joins up to three commands with the scope label', () => {
      assert.equal(
        buildDesignBlueprintTitle(['audit', 'polish'], 'src/renderer'),
        'Design remediation (audit+polish) — src/renderer'
      )
    })
    test('counts beyond three commands instead of listing them', () => {
      assert.equal(
        buildDesignBlueprintTitle(['a', 'b', 'c', 'd', 'e'], 'x'),
        'Design remediation (a+b+c+2) — x'
      )
    })
  })

  describe('classifyFinding', () => {
    test('detector findings are slop by construction', () => {
      assert.equal(classifyFinding(finding({ source: 'impeccable-detector' })), 'slop')
    })
    test('accessibility text routes to safety/harden', () => {
      assert.equal(classifyFinding(finding({ title: 'Buttons fail WCAG contrast' })), 'safety')
    })
    test('font and text-size talk routes to typography/typeset', () => {
      assert.equal(
        classifyFinding(finding({ title: 'Tiny typography', description: '10px text everywhere' })),
        'typography'
      )
    })
    test('re-render and lazy talk routes to performance', () => {
      assert.equal(
        classifyFinding(
          finding({ title: 'List re-render on toggle', description: 'missing memo' })
        ),
        'performance'
      )
    })
    test('unmatched findings fall back to general/polish', () => {
      assert.equal(
        classifyFinding(finding({ title: 'Something odd', description: 'hard to place' })),
        'general'
      )
    })
    test('every cluster maps to at least one impeccable command', () => {
      for (const cmds of Object.values(CLUSTER_COMMANDS)) assert.ok(cmds.length > 0)
    })
  })

  describe('formatDesignRemediationBrief', () => {
    const brief = formatDesignRemediationBrief({
      ...BASE,
      runId: 'run-42',
      findings: [
        finding({
          id: 'a',
          severity: 'low',
          title: 'Low first in input',
          description: 'order check'
        }),
        finding({
          id: 'b',
          severity: 'critical',
          title: 'Critical contrast failure',
          description: 'text is invisible on porcelain',
          filePath: 'src/x.tsx'
        })
      ]
    })

    test('orders findings worst severity first', () => {
      const criticalIdx = brief.indexOf('[CRITICAL]')
      const lowIdx = brief.indexOf('[LOW]')
      assert.ok(criticalIdx > -1 && lowIdx > -1 && criticalIdx < lowIdx)
    })
    test('carries the user brief as the goal', () => {
      assert.ok(brief.includes('Make the settings page feel less generic'))
    })
    test('carries the run lineage, files and command routing table', () => {
      assert.ok(brief.includes('run-42'))
      assert.ok(brief.includes('`src/x.tsx`'))
      assert.ok(brief.includes('| Impeccable command | Cluster | Findings |'))
    })
    test('empty findings still renders the header sections', () => {
      const empty = formatDesignRemediationBrief({ ...BASE, findings: [] })
      assert.ok(empty.includes('## Design remediation'))
      assert.ok(empty.includes('### Goal (user brief)'))
    })
  })
})

if (import.meta.url === `file://${process.argv[1]}`) void summaryAsync()
