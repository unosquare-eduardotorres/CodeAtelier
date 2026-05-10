/**
 * Unit tests for abandonment-detector.service — 3 pure exported functions:
 *   detectAbandonment, getReEngagementPrompt, detectQualityGates
 *
 * Pure logic: no filesystem, no network, no real Electron dependencies.
 * All functions are regex-based pattern matchers operating on strings.
 */
import assert from 'node:assert/strict'
import { test, describe } from './test-harness'

const {
  detectAbandonment,
  getReEngagementPrompt,
  detectQualityGates
} = require('../abandonment-detector.service') as typeof import('../abandonment-detector.service')

// ── detectAbandonment — normal / short / empty ──

describe('AbandonmentDetector — detectAbandonment basics', () => {
  test('detectAbandonment_returns_false_for_normal_output', () => {
    const output =
      'I have implemented the feature as requested. The component renders correctly ' +
      'and all existing tests continue to pass. Here is a summary of the changes I made ' +
      'to the codebase including the new file and the updated imports.'
    const result = detectAbandonment(output)
    assert.equal(result.detected, false, 'Normal output should not trigger abandonment')
  })

  test('detectAbandonment_returns_false_for_short_output', () => {
    const result = detectAbandonment('Done.')
    assert.equal(result.detected, false, 'Output < 20 chars should short-circuit to false')
  })

  test('detectAbandonment_returns_false_for_empty_string', () => {
    const result = detectAbandonment('')
    assert.equal(result.detected, false, 'Empty string should return detected: false')
  })
})

// ── detectAbandonment — positive detections ──

describe('AbandonmentDetector — detectAbandonment positive patterns', () => {
  test('detectAbandonment_detects_I_cannot_complete', () => {
    const output =
      'After examining the codebase extensively, I cannot complete this task because the ' +
      'required API endpoint does not exist and there is no way to create it.'
    const result = detectAbandonment(output)
    assert.equal(result.detected, true, 'Should detect "I cannot complete this"')
    assert.ok(result.pattern, 'Should include the matched pattern')
  })

  test('detectAbandonment_detects_give_up', () => {
    const output =
      'I have tried multiple approaches but none of them work. I give up on this task ' +
      'and recommend a different approach entirely.'
    const result = detectAbandonment(output)
    assert.equal(result.detected, true, 'Should detect "I give up"')
    assert.ok(result.pattern!.toLowerCase().includes('give up'), 'Pattern should contain "give up"')
  })

  test('detectAbandonment_detects_manual_intervention', () => {
    const output =
      "The configuration file is corrupted and the parser cannot handle it. " +
      "You'll need to manually fix this file before any automated tool can process it."
    const result = detectAbandonment(output)
    assert.equal(result.detected, true, 'Should detect "you\'ll need to manually"')
  })
})

// ── detectAbandonment — false positive guards ──

describe('AbandonmentDetector — false positive guards', () => {
  test('detectAbandonment_false_positive_guard_fixed', () => {
    // The abandonment pattern "I was unable to complete" appears, but within 500 chars
    // the guard "I fixed" also appears, so it should NOT be detected
    const output =
      'Initially I was unable to complete the migration due to a schema mismatch. ' +
      'After investigating, I fixed the column types and the migration now runs successfully. ' +
      'All tests pass and the database is in the correct state.'
    const result = detectAbandonment(output)
    assert.equal(result.detected, false, 'Guard "I fixed" should prevent false positive')
  })

  test('detectAbandonment_false_positive_guard_successfully', () => {
    // "I cannot" appears but "successfully" guard is nearby
    const output =
      'I cannot believe how tricky this was, but I successfully resolved the issue ' +
      'by refactoring the service layer to use dependency injection instead of singletons.'
    const result = detectAbandonment(output)
    assert.equal(result.detected, false, 'Guard "successfully" should prevent false positive')
  })

  test('detectAbandonment_only_checks_last_3000_chars', () => {
    // Abandonment text appears BEFORE the last 3000 chars
    // Success text appears at the end (within last 3000)
    const earlyAbandonment = 'I give up on this approach. '
    const padding = 'x'.repeat(4000) // Push abandonment text outside the 3000-char tail
    const successEnding =
      'After taking a different approach, I implemented the feature correctly. ' +
      'All tests pass and the build succeeds.'
    const output = earlyAbandonment + padding + successEnding
    const result = detectAbandonment(output)
    assert.equal(
      result.detected,
      false,
      'Abandonment text before last 3000 chars should not be detected'
    )
  })
})

// ── detectQualityGates ──

describe('AbandonmentDetector — detectQualityGates', () => {
  test('detectQualityGates_detects_test_failures', () => {
    const output = 'Running test suite...\n3 tests failing\n12 tests passed'
    const gates = detectQualityGates(output)
    const testGate = gates.find(
      (g: { type: string; passed: boolean }) => g.type === 'test' && !g.passed
    )
    assert.ok(testGate, 'Should detect a failing test gate')
    assert.equal(testGate!.passed, false)
    assert.ok(testGate!.summary.includes('3'), 'Summary should mention 3 failing')
  })

  test('detectQualityGates_detects_typescript_errors', () => {
    const output = 'src/main/index.ts(42,5): error TS2345: ...\nFound 5 errors.'
    const gates = detectQualityGates(output)
    const tsGate = gates.find(
      (g: { type: string; passed: boolean }) => g.type === 'typecheck' && !g.passed
    )
    assert.ok(tsGate, 'Should detect a failing typecheck gate')
    assert.equal(tsGate!.passed, false)
    assert.ok(tsGate!.summary.includes('5'), 'Summary should mention 5 errors')
  })
})

// ── getReEngagementPrompt ──

describe('AbandonmentDetector — getReEngagementPrompt', () => {
  test('getReEngagementPrompt_returns_direct_for_give_up', () => {
    const detection = { detected: true as const, pattern: 'I give up', context: '' }
    const prompt = getReEngagementPrompt(detection)
    assert.ok(prompt.length > 50, 'Prompt should be substantial')
    assert.ok(
      prompt.includes('different approach') || prompt.includes('continue working'),
      'Direct prompt should encourage continuation'
    )
  })
})
