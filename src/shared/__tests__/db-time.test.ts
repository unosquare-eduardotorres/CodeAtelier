/**
 * Unit tests for parseDbTimestamp.
 *
 * Assertions are deliberately offset-independent (compared against Date.UTC,
 * never against a locale-formatted string) so the suite is meaningful in CI
 * regardless of the runner's timezone — the bug under test is precisely a
 * timezone misreading.
 *
 * Run: tsx src/shared/__tests__/db-time.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../main/services/__tests__/test-harness'
import { parseDbTimestamp } from '../db-time'

describe('parseDbTimestamp', () => {
  test("SQLite datetime('now') output is read as UTC, not local", () => {
    const parsed = parseDbTimestamp('2026-08-05 16:02:00')
    assert.equal(parsed.getTime(), Date.UTC(2026, 7, 5, 16, 2, 0))
  })

  test('corrects the naive new Date() path by exactly the machine UTC offset', () => {
    const value = '2026-08-05 16:02:00'
    // The old code read the string as local time, i.e. it landed getTimezoneOffset()
    // minutes away from the true instant. Holds in any timezone, including UTC.
    const offsetMs = new Date(value).getTimezoneOffset() * 60_000
    assert.equal(parseDbTimestamp(value).getTime(), new Date(value).getTime() - offsetMs)
  })

  test('ISO-8601 with Z passes through unchanged', () => {
    const parsed = parseDbTimestamp('2026-08-05T16:02:00.000Z')
    assert.equal(parsed.getTime(), Date.UTC(2026, 7, 5, 16, 2, 0))
  })

  test('ISO-8601 with explicit offset is respected', () => {
    const parsed = parseDbTimestamp('2026-08-05T11:02:00-05:00')
    assert.equal(parsed.getTime(), Date.UTC(2026, 7, 5, 16, 2, 0))
  })

  test('invalid input yields an Invalid Date (NaN) rather than throwing', () => {
    assert.ok(Number.isNaN(parseDbTimestamp('not-a-date').getTime()))
  })

  test('partial datetime without seconds is not treated as naive UTC', () => {
    // Guard the regex: only the exact SQLite shape gets the Z appended.
    const parsed = parseDbTimestamp('2026-08-05 16:02')
    assert.equal(parsed.getTime(), new Date('2026-08-05 16:02').getTime())
  })
})

if (import.meta.url === `file://${process.argv[1]}`) {
  void summaryAsync()
}
