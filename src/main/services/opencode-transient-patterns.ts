/**
 * Shared transient-error classification for the OpenCode backend.
 *
 * Single source of truth for BOTH consumers:
 *  - opencode-executor.ts — decides whether an in-stream `error`/`api_retry`
 *    chunk warrants a resend with backoff (handleTransientRetry).
 *  - opencode-event-normalizer.ts — decides whether session.error is surfaced
 *    as `api_retry` (UI retry indicator) instead of a hard `error` chunk.
 *
 * Previously the two files maintained parallel copies of the list (the
 * normalizer's copy carried a "mirrors" comment) — any drift silently broke
 * one side or the other. Extracted so the lists can never diverge again.
 */

/** Transient error patterns that warrant retry with backoff */
export const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /rate.?limit/i,
  /overloaded/i,
  /server_is_overloaded/i,
  /too many requests/i,
  /503/,
  /429/,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ECONNREFUSED/,
  /network/i,
  /timeout/i,
  // SSE-TIMEOUT FIX: spaced/hyphenated/underscored forms ("timed out",
  // "timed-out", "timed_out") emitted by the opencode server on upstream
  // SSE read stalls — previously matched no pattern, so these were
  // misclassified as permanent and never retried.
  /timed[\s_-]?out/i
]

/** Slow-transient patterns: timeout / connection-stall class errors */
export const SLOW_TRANSIENT_PATTERNS: RegExp[] = [
  /timeout/i,
  /timed[\s_-]?out/i,
  /ETIMEDOUT/,
  /ECONNRESET/,
  /stalled/i
]

/**
 * SSE-TIMEOUT FIX: true when the error belongs to the timeout/connection-stall
 * class — these warrant the slow backoff base (SLOW_RETRY_BASE_DELAY_MS in the
 * executor) instead of the fast 2s base. Pure helper, exported for tests.
 */
export function isSlowTransientError(message: string): boolean {
  return SLOW_TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))
}
