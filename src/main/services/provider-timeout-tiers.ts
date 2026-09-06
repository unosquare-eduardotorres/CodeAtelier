/**
 * Provider timeout tiers — single source of truth for every timeout that
 * guards a model turn, local vs remote (anything not ollama/omlx).
 *
 * GAP-A (premortem): the values used to live as scattered constants, and the
 * blueprint task watchdog (STALL_TIMEOUT_MS = 300s) sat BELOW the executor's
 * remote mid-turn stall window (480s). On a remote provider a legitimately
 * slow-but-alive turn was therefore FAILED by the watchdog before the
 * executor's own stall retry — whose whole point is to recover it — could
 * fire. Every timeout below is owned here so that ordering can never drift
 * silently again.
 *
 * Ordering invariant (asserted by provider-timeout-tiers.test.ts):
 *
 *   noActivityMs < midTurnStallMs < taskWatchdogMs ≤ sdkReadMs
 *
 * Meaning, on the same provider:
 *   1. a stream that never starts activity dies first (noActivity),
 *   2. a stream that goes silent mid-turn is retried by the executor
 *      (midTurnStall) — the cheapest recovery,
 *   3. only if that retry budget is spent does the phase watchdog fail the
 *      task (taskWatchdog),
 *   4. and the SDK read timeout is the last-resort outer bound (sdkRead).
 *
 * Consumers:
 *   - opencode-config-writer.ts   → sdkReadMs / chunkTimeoutMs (opencode.json)
 *   - opencode-executor.ts        → noActivityMs / midTurnStallMs (stream
 *                                   watchers; explicit params still override)
 *   - blueprint-*.service.ts      → taskWatchdogMs (PhaseActivityWatchdog)
 */

export interface ProviderTimeoutTier {
  /** OpenCode SDK read timeout (opencode.json `timeout`). */
  sdkReadMs: number
  /** Per-chunk SSE timeout (opencode.json `chunkTimeout`). */
  chunkTimeoutMs: number
  /** Pre-activity backstop — a prompt that never produces any event. */
  noActivityMs: number
  /** Rolling no-activity window that applies after the first activity event. */
  midTurnStallMs: number
  /** PhaseActivityWatchdog window — the outer bound per task/phase turn. */
  taskWatchdogMs: number
}

/**
 * Local tier (ollama/omlx) — current values, unchanged.
 * Watchdog 300s equals the classic STALL_TIMEOUT_MS.
 */
const LOCAL_TIER: ProviderTimeoutTier = Object.freeze({
  sdkReadMs: 600_000,
  chunkTimeoutMs: 30_000,
  noActivityMs: 120_000,
  midTurnStallMs: 240_000,
  taskWatchdogMs: 300_000
})

/**
 * Remote tier (Z.ai/GLM, any cloud provider). Observed healthy remote build
 * turns run 7–8 min (461s p95) with server-side buffering, so the stall
 * windows scale with the 600s SDK read timeout (50% / 80%). The watchdog
 * moves to 540s (90%) — ABOVE the executor's 480s stall retry so the retry
 * fires first (GAP-A), still under the SDK's 600s kill.
 */
const REMOTE_TIER: ProviderTimeoutTier = Object.freeze({
  sdkReadMs: 600_000,
  chunkTimeoutMs: 120_000,
  noActivityMs: 300_000,
  midTurnStallMs: 480_000,
  taskWatchdogMs: 540_000
})

/**
 * Resolve the timeout tier for a provider.
 * @param isRemote true for anything that is not a local server (ollama/omlx).
 */
export function getTimeoutTier(isRemote: boolean): ProviderTimeoutTier {
  return isRemote ? REMOTE_TIER : LOCAL_TIER
}
