/**
 * Shared stream-segmentation predicates.
 *
 * Extracted from the renderer's StreamSegmentAccumulator so the size-threshold
 * commit rule is testable from the node-side test suite (main/shared tests
 * cannot import renderer modules).
 */

/**
 * A2 FIX: max chars of currentContent before the segment is finalized at the
 * next paragraph boundary. Without a heading/tool boundary, streams grew one
 * live bubble forever and the renderer re-parsed the FULL accumulated text on
 * every ~250ms flush (O(total) per flush → renderer CPU saturation). Capping
 * the segment bounds the live tail — and its re-parse cost — to roughly this
 * size. Splits only fire on paragraph boundaries outside fenced code blocks,
 * so committed segments stay markdown-safe.
 */
export const SEGMENT_CHAR_LIMIT = 1200

/**
 * F4 FIX: hard cap on accumulated segment size. Streams with no paragraph
 * boundary at all (e.g. one giant paragraph, or prose that never hits a blank
 * line) would grow the live tail forever under the soft rule alone. At this
 * size the segment commits on ANY flush outside a fenced code block — sentence
 * boundaries are markdown-safe outside fences, so splitting there cannot
 * corrupt a fenced block or a list. Inside a fence the hard rule still waits,
 * because a mid-fence split would render as two broken fences.
 *
 * Commit latency at the cap is bounded by SentenceBuffer's force-flush paths
 * (src/renderer/src/utils/sentence-buffer.ts): the 250 ms FLUSH_TIMEOUT timer
 * and the 200-char FLUSH_CHAR_LIMIT — both far below this cap — guarantee a
 * flush (and thus the hard-cap commit) fires promptly once the cap is crossed.
 */
export const SEGMENT_HARD_CAP_CHARS = 4800

/**
 * Should the current segment be finalized now that `flushedText` arrived?
 *
 * Soft rule: the segment is over the size cap AND this flush lands on a
 * paragraph boundary (trailing newline) AND we are not inside a fenced code
 * block. Paragraph-boundary flushes carry the trailing blank line; sentence-
 * only flushes do not, so the rule waits for a true break.
 *
 * Hard rule (F4): at SEGMENT_HARD_CAP_CHARS the segment commits on ANY flush
 * outside a fenced code block — no boundary required. Bounds the live tail
 * even for streams that never produce a paragraph boundary.
 */
export function shouldCommitForSize(
  currentContentLength: number,
  flushedText: string,
  insideCodeFence: boolean
): boolean {
  if (insideCodeFence) return false
  if (currentContentLength >= SEGMENT_HARD_CAP_CHARS) return true
  return currentContentLength >= SEGMENT_CHAR_LIMIT && flushedText.endsWith('\n')
}

/**
 * Fold fence-parity of newly flushed text into the running state.
 * Returns true when the flushed text leaves us INSIDE an unclosed ``` fence.
 * Line-oriented and O(lines) — cheap enough to run on every flush.
 */
export function fenceParityAfter(currentlyInside: boolean, flushedText: string): boolean {
  let inside = currentlyInside
  for (const line of flushedText.split('\n')) {
    if (line.trimStart().startsWith('```')) inside = !inside
  }
  return inside
}
