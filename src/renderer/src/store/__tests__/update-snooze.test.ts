/**
 * The snooze rule behind update.store's "Later"/dismiss.
 *
 * Background update checks run hourly. Before this rule existed only the modal's
 * closeModal() recorded a snooze — the banner's ✕ went through dismiss(), which
 * left no record, so the very next check re-opened the modal on an update the
 * user had just waved away.
 *
 * Extracted from the store so it can be tested without a renderer.
 *
 * Run: tsx src/renderer/src/store/__tests__/update-snooze.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from '../../../../main/services/__tests__/test-harness'
import {
  nextSnooze,
  isSnoozed,
  isBannerMuted,
  SNOOZE_MS,
  LATER_MUTES,
  DISMISS_MUTES
} from '../update-store-utils'

const NOW = 1_700_000_000_000

describe('nextSnooze', () => {
  test('mutes the advertised version for the snooze window', () => {
    const patch = nextSnooze(
      { status: 'available', availableVersion: '1.2.0', snoozedVersion: null, snoozeUntil: 0 },
      LATER_MUTES,
      NOW
    )
    assert.equal(patch.snoozedVersion, '1.2.0')
    assert.equal(patch.snoozeUntil, NOW + SNOOZE_MS)
  })

  test('the modal Later does not snooze a downloaded update', () => {
    // Closing the install modal is not declining the update — it must keep
    // announcing itself until the user dismisses it from the banner.
    const patch = nextSnooze(
      { status: 'ready', availableVersion: '1.2.0', snoozedVersion: null, snoozeUntil: 0 },
      LATER_MUTES,
      NOW
    )
    assert.deepEqual(patch, { snoozedVersion: null, snoozeUntil: 0 })
  })

  test('the banner ✕ snoozes a downloaded update', () => {
    const patch = nextSnooze(
      { status: 'ready', availableVersion: '1.2.0', snoozedVersion: null, snoozeUntil: 0 },
      DISMISS_MUTES,
      NOW
    )
    assert.equal(patch.snoozedVersion, '1.2.0')
    assert.equal(patch.snoozeUntil, NOW + SNOOZE_MS)
  })

  test('the banner ✕ also snoozes an available update', () => {
    const patch = nextSnooze(
      { status: 'available', availableVersion: '1.2.0', snoozedVersion: null, snoozeUntil: 0 },
      DISMISS_MUTES,
      NOW
    )
    assert.equal(patch.snoozedVersion, '1.2.0')
  })

  test('leaves an existing snooze untouched when dismissing an error', () => {
    // Dismissing an error must not silence a version the user never declined —
    // and must not clear one they did.
    const patch = nextSnooze(
      { status: 'error', availableVersion: '1.2.0', snoozedVersion: '1.1.0', snoozeUntil: 42 },
      DISMISS_MUTES,
      NOW
    )
    assert.deepEqual(patch, { snoozedVersion: '1.1.0', snoozeUntil: 42 })
  })

  test('does not snooze mid-download', () => {
    const patch = nextSnooze(
      { status: 'downloading', availableVersion: '1.2.0', snoozedVersion: null, snoozeUntil: 0 },
      DISMISS_MUTES,
      NOW
    )
    assert.deepEqual(patch, { snoozedVersion: null, snoozeUntil: 0 })
  })

  test('does not snooze when no version is known', () => {
    const patch = nextSnooze(
      { status: 'available', availableVersion: null, snoozedVersion: null, snoozeUntil: 0 },
      DISMISS_MUTES,
      NOW
    )
    assert.deepEqual(patch, { snoozedVersion: null, snoozeUntil: 0 })
  })
})

describe('isSnoozed', () => {
  test('suppresses the same version inside the window', () => {
    assert.equal(isSnoozed('1.2.0', '1.2.0', NOW + SNOOZE_MS, NOW), true)
  })

  test('lets a newer version through', () => {
    // A release published during the snooze must still interrupt.
    assert.equal(isSnoozed('1.3.0', '1.2.0', NOW + SNOOZE_MS, NOW), false)
  })

  test('lets the same version through once the window expires', () => {
    assert.equal(isSnoozed('1.2.0', '1.2.0', NOW - 1, NOW), false)
  })

  test('is a no-op when nothing was ever snoozed', () => {
    assert.equal(isSnoozed('1.2.0', null, 0, NOW), false)
  })
})

describe('isBannerMuted', () => {
  test('hides an available update the user dismissed', () => {
    assert.equal(isBannerMuted('available', '1.2.0', '1.2.0', NOW + SNOOZE_MS, NOW), true)
  })

  test('hides a downloaded update the user dismissed', () => {
    // It still installs on quit, and Settings still offers it — only the banner
    // stops occupying the top of the window.
    assert.equal(isBannerMuted('ready', '1.2.0', '1.2.0', NOW + SNOOZE_MS, NOW), true)
  })

  test('never hides a download in flight', () => {
    // Regression guard: snoozing v1.2.0 and then downloading it must not blank
    // out the progress banner.
    assert.equal(isBannerMuted('downloading', '1.2.0', '1.2.0', NOW + SNOOZE_MS, NOW), false)
  })

  test('never hides an error', () => {
    assert.equal(isBannerMuted('error', '1.2.0', '1.2.0', NOW + SNOOZE_MS, NOW), false)
  })

  test('lets a newer version through', () => {
    assert.equal(isBannerMuted('available', '1.3.0', '1.2.0', NOW + SNOOZE_MS, NOW), false)
  })

  test('lets the version back once the window expires', () => {
    assert.equal(isBannerMuted('available', '1.2.0', '1.2.0', NOW - 1, NOW), false)
  })

  test('is a no-op when no version is known', () => {
    assert.equal(isBannerMuted('available', null, '1.2.0', NOW + SNOOZE_MS, NOW), false)
  })
})

// ── Standalone runner ─────────────────────────────────────────────────────
if (process.argv[1]?.includes('update-snooze')) {
  void summaryAsync()
}
