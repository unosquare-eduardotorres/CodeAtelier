/**
 * Tests for auto-update-helpers.ts — the decisions that made the updater fail
 * silently.
 *
 * Two real symptoms are pinned here:
 *   1. "Check for Updates does nothing" — a 404 on a user-initiated check was
 *      swallowed by the same suppression meant for the quiet startup check.
 *   2. "Current version: 1.0.64" logged on a box running 1.0.65 — the feed was
 *      advertising an older build than the one installed, which is a stale-feed
 *      signature, not "you are up to date".
 *
 * Run: tsx src/main/services/__tests__/auto-update-helpers.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import {
  compareVersions,
  describeUpdateError,
  isFeedUnreachable,
  isStaleFeed,
  shouldReportError
} from '../auto-update-helpers'

describe('auto-update-helpers — compareVersions', () => {
  test('orders_by_numeric_segment_not_lexically', () => {
    assert.equal(compareVersions('1.0.65', '1.0.64'), 1)
    assert.equal(compareVersions('1.0.64', '1.0.65'), -1)
    assert.equal(compareVersions('1.0.65', '1.0.65'), 0)
    // Lexical comparison would call 1.0.9 newer than 1.0.65.
    assert.equal(compareVersions('1.0.9', '1.0.65'), -1)
  })

  test('treats_missing_segments_as_zero', () => {
    assert.equal(compareVersions('1.1', '1.1.0'), 0)
    assert.equal(compareVersions('2', '1.9.9'), 1)
  })

  test('tolerates_prefixes_prereleases_and_junk', () => {
    assert.equal(compareVersions('v1.0.65', '1.0.65'), 0)
    assert.equal(compareVersions('1.0.66-beta.1', '1.0.65'), 1)
    assert.equal(compareVersions('not.a.version', '0.0.0'), 0)
  })
})

describe('auto-update-helpers — isStaleFeed', () => {
  test('flags_a_feed_advertising_an_older_build_than_installed', () => {
    // Exactly what the Windows box saw: feed said 1.0.64, app was 1.0.65.
    assert.equal(isStaleFeed('1.0.64', '1.0.65'), true)
  })

  test('same_version_is_not_stale', () => {
    assert.equal(isStaleFeed('1.0.65', '1.0.65'), false)
  })

  test('newer_feed_is_not_stale', () => {
    assert.equal(isStaleFeed('1.0.66', '1.0.65'), false)
  })

  test('missing_versions_never_warn', () => {
    assert.equal(isStaleFeed('', '1.0.65'), false)
    assert.equal(isStaleFeed('1.0.65', ''), false)
  })
})

describe('auto-update-helpers — error reporting policy', () => {
  test('recognises_an_unreachable_feed', () => {
    assert.equal(isFeedUnreachable('HttpError: 404 Not Found'), true)
    assert.equal(isFeedUnreachable('Error: ENOENT no such file'), false)
  })

  test('automatic_check_stays_quiet_about_an_unreachable_feed', () => {
    assert.equal(shouldReportError('HttpError: 404 Not Found', false), false)
  })

  test('user_initiated_check_always_reports_even_a_404', () => {
    // The regression this whole change exists for: the button appeared dead
    // because the only failure mode it could hit was suppressed.
    assert.equal(shouldReportError('HttpError: 404 Not Found', true), true)
  })

  test('genuine_failures_report_on_automatic_checks_too', () => {
    assert.equal(shouldReportError('ClientRequest only supports http:', false), true)
  })
})

describe('auto-update-helpers — describeUpdateError', () => {
  test('appends_the_feed_location_so_the_user_can_see_where_we_looked', () => {
    const msg = describeUpdateError('HttpError: 404', '/Users/x/OneDrive/Code Atelier')
    assert.ok(msg.includes('HttpError: 404'))
    assert.ok(msg.includes('/Users/x/OneDrive/Code Atelier'))
  })

  test('omits_the_source_clause_when_no_feed_is_known', () => {
    assert.equal(describeUpdateError('boom', ''), 'boom')
  })

  test('never_returns_an_empty_message', () => {
    assert.equal(describeUpdateError('   ', ''), 'Unknown error')
  })
})

if (process.argv[1]?.includes('auto-update-helpers')) {
  void summaryAsync()
}
