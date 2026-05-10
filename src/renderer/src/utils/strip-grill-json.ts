/**
 * Shared utility: robust grill-evaluation JSON stripping.
 *
 * Removes raw `grill-evaluation` fenced blocks (and unfenced JSON payloads)
 * from streaming or finalized markdown content. Handles variations from
 * different LLMs: 3+ backtick fences, trailing spaces, missing closing
 * fences (mid-stream), and completely unfenced JSON.
 */

/**
 * Strip grill-evaluation blocks from markdown content.
 *
 * Patterns handled:
 * 1. Standard fenced blocks with 3+ backticks
 * 2. Partial fenced blocks (no closing fence — mid-stream)
 * 3. Unfenced: "grill-evaluation" on its own line followed by JSON
 * 4. Stray JSON starting with `{"trackId":` (grill eval payload without any fence)
 */
export function stripGrillEvaluationBlocks(text: string): string {
  let cleaned = text

  // 1. Standard fenced blocks (3+ backticks on open and close)
  cleaned = cleaned.replace(/`{3,}\s*grill-evaluation\s*\n[\s\S]*?`{3,}/g, '')

  // 2. Partial fenced blocks (opening fence present, no closing fence yet — mid-stream)
  cleaned = cleaned.replace(/`{3,}\s*grill-evaluation[\s\S]*$/g, '')

  // 3. Unfenced: "grill-evaluation" on its own line followed by JSON-like content
  cleaned = cleaned.replace(/^grill-evaluation\s*\n\s*\{[\s\S]*$/m, '')

  // 4. Stray JSON that starts with {"trackId": (grill eval payload without any fence)
  cleaned = cleaned.replace(/\{"trackId"\s*:\s*"[^"]*"\s*,\s*"score"\s*:[\s\S]*$/m, '')

  return cleaned.trim()
}
