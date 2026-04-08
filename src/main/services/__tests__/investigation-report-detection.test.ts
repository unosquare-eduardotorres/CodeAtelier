/**
 * Unit tests for investigation report detection in specialist-pool.service.ts.
 * Tests the regex matching and JSON parsing that extracts investigation reports.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

describe('Investigation report detection', () => {
  const REPORT_REGEX = /```investigation-report\s*\n([\s\S]*?)```/

  test('matches standard investigation-report block', () => {
    const output =
      'Some analysis...\n```investigation-report\n{"problem":"test","rootCause":"x","proposedFix":"y","filesAffected":[],"impact":"medium","impactReason":"z"}\n```\nDone.'
    const match = output.match(REPORT_REGEX)
    assert.ok(match, 'Expected regex match')
    const report = JSON.parse(match![1].trim())
    assert.equal(report.problem, 'test')
    assert.equal(report.impact, 'medium')
  })

  test('matches block with extra whitespace after fence marker', () => {
    const output =
      '```investigation-report  \n{"problem":"test","rootCause":"x","proposedFix":"y","filesAffected":[],"impact":"low","impactReason":"z"}\n```'
    const match = output.match(REPORT_REGEX)
    assert.ok(match, 'Expected regex match')
  })

  test('matches block with multiline JSON', () => {
    const output =
      '```investigation-report\n{\n  "problem": "NullRef in TokenService",\n  "rootCause": "user.Role is null",\n  "proposedFix": "Add null check",\n  "filesAffected": [{"path": "src/TokenService.cs", "reason": "Missing null check"}],\n  "impact": "high",\n  "impactReason": "500 error on auth"\n}\n```'
    const match = output.match(REPORT_REGEX)
    assert.ok(match, 'Expected regex match')
    const report = JSON.parse(match![1].trim())
    assert.equal(report.filesAffected.length, 1)
  })

  test('does not match without investigation-report marker', () => {
    const output = '```json\n{"problem":"test"}\n```'
    const match = output.match(REPORT_REGEX)
    assert.equal(match, null)
  })

  test('does not match incomplete fence', () => {
    const output = '```investigation-report\n{"problem":"test"}'
    const match = output.match(REPORT_REGEX)
    assert.equal(match, null)
  })

  test('handles JSON with special characters', () => {
    const output =
      '```investigation-report\n{"problem":"Error: \\"null\\" in line 25","rootCause":"Missing check","proposedFix":"Add guard","filesAffected":[],"impact":"medium","impactReason":"Auth failure"}\n```'
    const match = output.match(REPORT_REGEX)
    assert.ok(match, 'Expected regex match')
    const report = JSON.parse(match![1].trim())
    assert.ok(report.problem.includes('null'))
  })

  test('detects investigation task from description', () => {
    const descriptions = [
      'Investigate the NullReferenceException in TokenService',
      'Produce a structured investigation report',
      'investigate why auth fails'
    ]
    for (const desc of descriptions) {
      const isInvestigation =
        desc.toLowerCase().includes('investigation report') ||
        desc.toLowerCase().includes('investigate')
      assert.equal(isInvestigation, true, `Expected "${desc}" to be detected as investigation`)
    }
  })

  test('non-investigation task is not flagged', () => {
    const desc = 'Implement user login feature'
    const isInvestigation =
      desc.toLowerCase().includes('investigation report') ||
      desc.toLowerCase().includes('investigate')
    assert.equal(isInvestigation, false)
  })
})

describe('Tool-emitted investigation report', () => {
  test('InvestigationReportSchema validates valid report', () => {
    const { InvestigationReportSchema } = require('../../services/specialist/structured-output')
    const report = InvestigationReportSchema.parse({
      problem: 'NullRef in TokenService',
      rootCause: 'user.Role is null when session expires',
      proposedFix: 'Add null check before accessing Role property',
      filesAffected: [{ path: 'src/TokenService.cs', reason: 'Missing null guard' }],
      impact: 'high',
      impactReason: 'Causes 500 error on every auth request'
    })
    assert.equal(report.problem, 'NullRef in TokenService')
    assert.equal(report.impact, 'high')
    assert.equal(report.filesAffected.length, 1)
  })

  test('InvestigationReportSchema rejects invalid impact level', () => {
    const { InvestigationReportSchema } = require('../../services/specialist/structured-output')
    assert.throws(() =>
      InvestigationReportSchema.parse({
        problem: 'test',
        rootCause: 'test',
        proposedFix: 'test',
        filesAffected: [],
        impact: 'invalid',
        impactReason: 'test'
      })
    )
  })

  test('InvestigationReportSchema rejects missing required fields', () => {
    const { InvestigationReportSchema } = require('../../services/specialist/structured-output')
    assert.throws(() =>
      InvestigationReportSchema.parse({
        problem: 'test'
        // missing rootCause, proposedFix, filesAffected, impact, impactReason
      })
    )
  })
})
