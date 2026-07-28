/**
 * Pure helper for resolving human-review banner state.
 *
 * Extracted to src/shared/ so it's testable from the main test harness
 * (same pattern as blueprint-hydration-helpers).
 */

export type VerifyBannerState = 'human-review' | 'acknowledged' | 'none'

/**
 * Determines what the verify banner should display:
 * - 'human-review': unacknowledged human_needed → show banner with Mark as Verified button
 * - 'acknowledged': human_needed + acknowledged → show slim success note
 * - 'none': any other verify status (passed, gaps_found, null) → no human-review banner
 */
export function resolveVerifyBannerState(
  verifyStatus: string | null | undefined,
  humanReviewAcknowledged: boolean
): VerifyBannerState {
  if (verifyStatus !== 'human_needed') return 'none'
  return humanReviewAcknowledged ? 'acknowledged' : 'human-review'
}
