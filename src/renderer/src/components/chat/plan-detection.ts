/**
 * Shared plan-block detection patterns.
 *
 * Used by MessageList (latest-plan detection scan) and useMessageContent
 * (plan content extraction). Centralised here to prevent regex divergence.
 */

/** Matches ``` plan blocks in message content (test-only, no capture group). */
export const PLAN_BLOCK_RE = /`{3,4}plan\n[\s\S]*?`{3,4}/

/** Same pattern with capture group for extracting plan content. */
export const PLAN_BLOCK_CAPTURE_RE = /`{3,4}plan\n([\s\S]*?)`{3,4}/

/** Matches ```build-summary blocks. Used to exclude messages that contain
 *  both a build-summary and a plan block — MessageCardRenderer prioritizes
 *  build-summary, so the plan card is never rendered in that case. */
export const BUILD_SUMMARY_RE = /```build-summary\n[\s\S]*?```/
