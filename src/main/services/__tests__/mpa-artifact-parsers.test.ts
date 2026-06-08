/**
 * Unit tests for mpa-artifact-parsers.ts — extracts plan / verify-report
 * artifacts from agent output (tagged block first, JSON-pattern fallback).
 * Pure logic.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { parsePlanArtifact, parseVerifyReport, hasFailingCriteria } from '../mpa-artifact-parsers'
import type { MpaVerifyReport } from '../../../shared/mpa-types'

function makeReport(criteriaResults: unknown): MpaVerifyReport {
  return {
    allComplete: true,
    totalItems: 0,
    implemented: 0,
    partial: 0,
    missing: 0,
    issues: [],
    crossCutting: {
      frontendBackendConnected: true,
      backendDatabaseConnected: true,
      routesRegistered: true,
      testsPass: true
    },
    testOutput: '',
    // Widened so we can feed malformed values the guard must tolerate.
    criteriaResults: criteriaResults as MpaVerifyReport['criteriaResults']
  }
}

describe('parsePlanArtifact', () => {
  test('parses a ```goal-plan tagged block', () => {
    const text = '```goal-plan\n{"items":[{"id":1}]}\n```'
    const out = parsePlanArtifact(text)
    assert.ok(out)
    assert.equal(out!.items.length, 1)
  })

  test('falls back to a raw JSON object containing items[]', () => {
    const text = 'Here is the plan: {"items":[{"id":1},{"id":2}]} done'
    const out = parsePlanArtifact(text)
    assert.ok(out)
    assert.equal(out!.items.length, 2)
  })

  test('returns null when items is missing', () => {
    assert.equal(parsePlanArtifact('```goal-plan\n{"foo":1}\n```'), null)
  })

  test('returns null on invalid JSON', () => {
    assert.equal(parsePlanArtifact('```goal-plan\n{ broken\n```'), null)
  })

  test('returns null when no plan present', () => {
    assert.equal(parsePlanArtifact('no artifacts here'), null)
  })
})

describe('parseVerifyReport', () => {
  test('parses a ```goal-verify-report tagged block', () => {
    const text = '```goal-verify-report\n{"allComplete":true}\n```'
    const out = parseVerifyReport(text)
    assert.ok(out)
    assert.equal(out!.allComplete, true)
  })

  test('falls back to raw JSON containing allComplete key', () => {
    const out = parseVerifyReport('report: {"allComplete":false,"notes":"x"}')
    assert.ok(out)
    assert.equal(out!.allComplete, false)
  })

  test('returns null when allComplete key is absent', () => {
    assert.equal(parseVerifyReport('```goal-verify-report\n{"other":1}\n```'), null)
  })

  test('returns null on invalid JSON', () => {
    assert.equal(parseVerifyReport('```goal-verify-report\nnope\n```'), null)
  })

  test('returns null when no report present', () => {
    assert.equal(parseVerifyReport('plain text'), null)
  })
})

describe('hasFailingCriteria', () => {
  test('true when any criterion has status fail', () => {
    const report = makeReport([
      { criterion: 'a', status: 'pass', detail: '' },
      { criterion: 'b', status: 'fail', detail: 'missing' }
    ])
    assert.equal(hasFailingCriteria(report), true)
  })

  test('false when all criteria pass', () => {
    const report = makeReport([{ criterion: 'a', status: 'pass', detail: '' }])
    assert.equal(hasFailingCriteria(report), false)
  })

  test('false for null / undefined report', () => {
    assert.equal(hasFailingCriteria(null), false)
    assert.equal(hasFailingCriteria(undefined), false)
  })

  test('false when criteriaResults is absent', () => {
    assert.equal(hasFailingCriteria(makeReport(undefined)), false)
  })

  test('does not throw when criteriaResults is a non-array (malformed model output)', () => {
    // The guard exists precisely so a non-array value cannot throw and
    // spuriously fail a run.
    assert.equal(hasFailingCriteria(makeReport('fail')), false)
    assert.equal(hasFailingCriteria(makeReport({ status: 'fail' })), false)
    assert.equal(hasFailingCriteria(makeReport(42)), false)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
