/**
 * Tests for per-criterion verification (campaign goals):
 *  - parseVerifyReport passes the criteriaResults array through.
 *  - buildVerifierSystemPrompt emits a Success Criteria section + criteriaResults
 *    instruction when successCriteria are supplied, and omits them otherwise.
 */

import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parseVerifyReport } from '../mpa-artifact-parsers'
import { buildVerifierSystemPrompt } from '../mpa-prompts'
import type { MpaPlanArtifact } from '../../../shared/mpa-types'

const PLAN: MpaPlanArtifact = {
  goalType: 'feature',
  summary: 'x',
  items: [
    {
      id: 'P1',
      title: 'Item',
      description: 'd',
      files: ['a.ts'],
      scope: 'frontend',
      dependsOn: [],
      includesTests: false
    }
  ],
  risks: [],
  existingPatterns: []
}

describe('parseVerifyReport — criteriaResults', () => {
  test('parses criteriaResults from a goal-verify-report block', () => {
    const text = [
      '```goal-verify-report',
      JSON.stringify({
        allComplete: false,
        totalItems: 1,
        implemented: 1,
        partial: 0,
        missing: 0,
        issues: [],
        crossCutting: {
          frontendBackendConnected: true,
          backendDatabaseConnected: true,
          routesRegistered: true,
          testsPass: true
        },
        testOutput: 'ok',
        criteriaResults: [
          { criterion: 'Renders questions', status: 'pass', detail: 'present' },
          { criterion: 'Keyboard navigable', status: 'fail', detail: 'no focus ring' }
        ]
      }),
      '```'
    ].join('\n')

    const report = parseVerifyReport(text)
    assert.ok(report)
    assert.equal(report!.criteriaResults?.length, 2)
    assert.equal(report!.criteriaResults?.[1].status, 'fail')
  })

  test('report without criteriaResults still parses', () => {
    const text =
      '```goal-verify-report\n{"allComplete": true, "totalItems": 0, "implemented": 0, "partial": 0, "missing": 0, "issues": [], "crossCutting": {"frontendBackendConnected": true, "backendDatabaseConnected": true, "routesRegistered": true, "testsPass": true}, "testOutput": ""}\n```'
    const report = parseVerifyReport(text)
    assert.ok(report)
    assert.equal(report!.criteriaResults, undefined)
  })
})

describe('buildVerifierSystemPrompt — success criteria', () => {
  test('includes Success Criteria + criteriaResults when provided', () => {
    const prompt = buildVerifierSystemPrompt({
      goal: 'g',
      plan: PLAN,
      workspaceName: 'WS',
      successCriteria: ['Renders questions', 'Keyboard navigable']
    })
    assert.ok(prompt.includes('Success Criteria'), 'should include the criteria heading')
    assert.ok(prompt.includes('Renders questions'))
    assert.ok(prompt.includes('criteriaResults'), 'should require a criteriaResults array')
  })

  test('omits criteria section when none provided', () => {
    const prompt = buildVerifierSystemPrompt({ goal: 'g', plan: PLAN, workspaceName: 'WS' })
    assert.ok(!prompt.includes('Success Criteria'))
    assert.ok(!prompt.includes('criteriaResults'))
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
