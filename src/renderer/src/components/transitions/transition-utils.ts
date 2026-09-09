/**
 * Light transition helpers — intentionally free of heavy imports.
 * AppLayout loads this module eagerly (via useTransitionState); the Three.js
 * teardown helpers live next to their only consumer (GoldParticleAnimation)
 * so `three` stays out of the startup bundle until an animation actually runs.
 */

/** Check if user prefers reduced motion */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
}

/** Check if running in E2E test environment */
export function isE2ETesting(): boolean {
  return (
    !!(window as unknown as Record<string, unknown>).__E2E_TESTING__ ||
    (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test')
  )
}

// ── User-initiated transition gate ──
let _userInitiated = false

/** Mark the next workspace open as user-initiated (eligible for animation) */
export function markUserInitiatedOpen(): void {
  _userInitiated = true
}

/** Consume and reset the user-initiated flag */
export function consumeUserInitiated(): boolean {
  const v = _userInitiated
  _userInitiated = false
  return v
}
