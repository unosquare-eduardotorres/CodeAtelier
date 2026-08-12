/**
 * update-store-utils.ts — the snooze rule extracted from update.store.ts so it
 * can be tested without a renderer.
 *
 * Background checks run hourly. Without a snooze, declining an update once means
 * the modal re-opens on the next tick — every hour, forever. Both ways of saying
 * "not now" (the modal's Later/✕ and the banner's ✕) must record it.
 *
 * Pure functions — no set()/get(), no side effects.
 */

/** How long "Later"/dismiss keeps a version quiet. */
export const SNOOZE_MS = 4 * 60 * 60 * 1000

/**
 * What the modal's "Later"/✕ mutes. A downloaded update is deliberately absent:
 * closing the install modal is not the same as declining the update.
 */
export const LATER_MUTES: readonly string[] = ['available']

/**
 * What the banner's ✕ mutes. Includes 'ready': a downloaded update the user
 * waved away must stop occupying the top of the window — it still installs on
 * quit, and Settings still offers it.
 */
export const DISMISS_MUTES: readonly string[] = ['available', 'ready']

interface SnoozeState {
  status: string
  availableVersion: string | null
  snoozedVersion: string | null
  snoozeUntil: number
}

export interface SnoozePatch {
  snoozedVersion: string | null
  snoozeUntil: number
}

/**
 * "Later"/dismiss mutes one version for a while; anything else leaves the
 * existing snooze alone — dismissing an error or a download must not silence a
 * version the user never saw offered. `mutes` is the caller's scope:
 * LATER_MUTES for the modal, DISMISS_MUTES for the banner.
 */
export function nextSnooze(
  state: SnoozeState,
  mutes: readonly string[],
  now = Date.now()
): SnoozePatch {
  if (!mutes.includes(state.status) || !state.availableVersion) {
    return { snoozedVersion: state.snoozedVersion, snoozeUntil: state.snoozeUntil }
  }
  return { snoozedVersion: state.availableVersion, snoozeUntil: now + SNOOZE_MS }
}

/**
 * An advertised version is suppressed only while its own snooze is live — a
 * newer version, or an expired window, always gets through.
 */
export function isSnoozed(
  version: string,
  snoozedVersion: string | null,
  snoozeUntil: number,
  now = Date.now()
): boolean {
  return snoozedVersion === version && now < snoozeUntil
}

/**
 * Should the banner stay out of the way? Only the two "here is a version, do
 * something about it" states can be muted — a download in flight and an error
 * always show, because the snooze is about declining an offer, not about hiding
 * what the app is doing right now.
 */
export function isBannerMuted(
  status: string,
  availableVersion: string | null,
  snoozedVersion: string | null,
  snoozeUntil: number,
  now = Date.now()
): boolean {
  if (!DISMISS_MUTES.includes(status) || !availableVersion) return false
  return isSnoozed(availableVersion, snoozedVersion, snoozeUntil, now)
}
