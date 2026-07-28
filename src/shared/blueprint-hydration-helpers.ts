/**
 * Pure helpers for blueprint transcript hydration decisions.
 *
 * Extracted from blueprint.store.ts for unit testing.
 * No store, DOM, or Electron dependencies.
 */

/**
 * Possible pre-fetch actions for hydrateTranscript to take.
 *
 * - 'skip'              — already hydrated (with messages) or in-flight, do nothing
 * - 'clear-then-apply'  — chatMessages belong to a different BP, clear first then fetch
 * - 'apply'             — no live messages present, fetch and apply
 *
 * Post-fetch merge/apply is handled by `resolvePostFetchAction`.
 */
export type HydrationAction = 'skip' | 'clear-then-apply' | 'apply'

/**
 * Determine what hydrateTranscript should do given the current state.
 *
 * @param liveCount      - current chatMessages.length
 * @param currentBpId    - currentBlueprint?.id (may be null)
 * @param targetBpId     - the blueprintId being hydrated
 * @param hydratedBpId   - module-level sentinel (which BP was last hydrated)
 * @param inFlight       - whether a hydration fetch is already in progress for targetBpId
 */
export function resolveHydrationAction(
  liveCount: number,
  currentBpId: string | null,
  targetBpId: string,
  hydratedBpId: string | null,
  inFlight: boolean
): HydrationAction {
  // Another hydration for this BP is already in-flight (StrictMode / race guard)
  if (inFlight) return 'skip'

  // Already hydrated for this exact blueprint AND messages still present.
  // If liveCount is 0 despite sentinel match, the transcript was blown away
  // by startBlueprint/cancelBlueprint/retryPhase — must re-hydrate.
  if (hydratedBpId === targetBpId && liveCount > 0) return 'skip'

  // CRITICAL-1: chatMessages belong to a different blueprint (live-watched or
  // previously hydrated) — must clear before applying new data.
  if (liveCount > 0 && currentBpId !== targetBpId) return 'clear-then-apply'

  // Live messages exist for THIS blueprint (IPC events arrived first) — skip
  // (the live stream is authoritative; hydration is unnecessary).
  if (liveCount > 0 && currentBpId === targetBpId) return 'skip'

  // No live messages — clean apply (normal historical view path, or
  // re-hydrate after transcript was cleared with sentinel still set).
  return 'apply'
}

/**
 * After-fetch decision: should we merge or clean-apply?
 * Called after the async fetch completes — liveMessages may have arrived
 * during the fetch (restart-during-active-run race).
 *
 * @param liveCountAfterFetch - chatMessages.length after the fetch
 */
export function resolvePostFetchAction(
  liveCountAfterFetch: number
): 'apply' | 'merge' {
  return liveCountAfterFetch === 0 ? 'apply' : 'merge'
}
