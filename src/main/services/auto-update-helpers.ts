/**
 * Pure helpers for auto-update.service.ts.
 *
 * Kept in their own module so they can be unit-tested without importing
 * electron-updater and the repository layer.
 */

/** Split a dotted version into numeric parts; non-numeric segments count as 0. */
function parts(version: string): number[] {
  return version
    .trim()
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => {
      const n = Number(part)
      return Number.isFinite(n) ? n : 0
    })
}

/** Compare dotted versions. Returns -1 (a < b), 0 (equal) or 1 (a > b). */
export function compareVersions(a: string, b: string): number {
  const left = parts(a)
  const right = parts(b)
  const len = Math.max(left.length, right.length)
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

/**
 * True when the feed advertises a version older than the one installed.
 *
 * This is the exact signature of a stale or corrupted feed — the case that went
 * unnoticed for a day because the mislabelled log printed the feed's version as
 * "Current version".
 */
export function isStaleFeed(feedVersion: string, appVersion: string): boolean {
  if (!feedVersion || !appVersion) return false
  return compareVersions(feedVersion, appVersion) < 0
}

/** An unreachable / missing feed, as opposed to a genuine transport failure. */
export function isFeedUnreachable(message: string): boolean {
  return message.includes('404') || message.includes('HttpError')
}

/**
 * Should this update error reach the user?
 *
 * Automatic startup checks stay quiet about an unreachable feed — that is the
 * expected state when no release source is configured. A check the user asked
 * for always reports its outcome, otherwise the button appears to do nothing.
 */
export function shouldReportError(message: string, userInitiated: boolean): boolean {
  return userInitiated || !isFeedUnreachable(message)
}

/** One-line, user-readable update failure including where we looked. */
export function describeUpdateError(message: string, feedDescription: string): string {
  const detail = message.trim() || 'Unknown error'
  return feedDescription ? `${detail} (update source: ${feedDescription})` : detail
}
