/**
 * Tests for isVersionBelow — extracted from subscription.service.ts.
 *
 * Covers semver-style version comparison with variable-length tuples,
 * pre-release suffixes, and edge cases.
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { isVersionBelow } from '../subscription.service'

describe('isVersionBelow — equal versions', () => {
  test('equal versions → false', () => {
    assert.equal(isVersionBelow('2.1.139', '2.1.139'), false)
  })

  test('both "0.0.0" → false', () => {
    assert.equal(isVersionBelow('0.0.0', '0.0.0'), false)
  })
})

describe('isVersionBelow — standard comparisons', () => {
  test('below → true', () => {
    assert.equal(isVersionBelow('2.1.100', '2.1.139'), true)
  })

  test('above → false', () => {
    assert.equal(isVersionBelow('2.1.200', '2.1.139'), false)
  })

  test('major version below → true', () => {
    assert.equal(isVersionBelow('1.9.999', '2.0.0'), true)
  })

  test('major version above → false', () => {
    assert.equal(isVersionBelow('3.0.0', '2.1.139'), false)
  })

  test('minor version below → true', () => {
    assert.equal(isVersionBelow('2.0.999', '2.1.0'), true)
  })
})

describe('isVersionBelow — variable-length version strings', () => {
  test('shorter version → missing parts treated as 0 → true', () => {
    assert.equal(isVersionBelow('2.1', '2.1.139'), true)
  })

  test('shorter version equal → false', () => {
    assert.equal(isVersionBelow('2.1', '2.1.0'), false)
  })

  test('longer version → extra parts make it above → false', () => {
    assert.equal(isVersionBelow('2.1.139.1', '2.1.139'), false)
  })

  test('single-segment versions', () => {
    assert.equal(isVersionBelow('1', '2'), true)
    assert.equal(isVersionBelow('2', '1'), false)
  })
})

describe('isVersionBelow — pre-release suffixes', () => {
  test('pre-release suffix parsed as extra numeric segment', () => {
    // "2.1.139-beta.1" → [2,1,139,1] which is above [2,1,139]
    assert.equal(isVersionBelow('2.1.139-beta.1', '2.1.139'), false)
  })

  test('pre-release on minimum side', () => {
    // "2.1.139" → [2,1,139] vs "2.1.139-beta.2" → [2,1,139,2]
    // current has fewer parts, missing = 0, so 0 < 2 → true
    assert.equal(isVersionBelow('2.1.139', '2.1.139-beta.2'), true)
  })
})

describe('isVersionBelow — edge cases', () => {
  test('empty string vs version → all zeros → true', () => {
    assert.equal(isVersionBelow('', '2.1.139'), true)
  })

  test('version vs empty string → false', () => {
    assert.equal(isVersionBelow('2.1.139', ''), false)
  })

  test('both empty → false (equal)', () => {
    assert.equal(isVersionBelow('', ''), false)
  })

  test('non-numeric garbage → all zeros → treated as below', () => {
    assert.equal(isVersionBelow('abc', '2.1.139'), true)
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
