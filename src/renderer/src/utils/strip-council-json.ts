/**
 * Shared utility: strip council JSON blocks from markdown content.
 *
 * Removes `council-review`, `council-peer-review`, and `council-verdict`
 * fenced blocks from streaming or finalized markdown content.
 * Same pattern as strip-grill-json.ts.
 */

/**
 * Strip all council-related fenced JSON blocks from markdown content.
 *
 * Patterns handled:
 * 1. Standard fenced blocks with 3+ backticks
 * 2. Partial fenced blocks (no closing fence — mid-stream)
 */
export function stripCouncilJsonBlocks(text: string): string {
  let cleaned = text

  // council-review blocks
  cleaned = cleaned.replace(/`{3,}\s*council-review\s*\n[\s\S]*?`{3,}/g, '')
  cleaned = cleaned.replace(/`{3,}\s*council-review[\s\S]*$/g, '')

  // council-peer-review blocks
  cleaned = cleaned.replace(/`{3,}\s*council-peer-review\s*\n[\s\S]*?`{3,}/g, '')
  cleaned = cleaned.replace(/`{3,}\s*council-peer-review[\s\S]*$/g, '')

  // council-verdict blocks
  cleaned = cleaned.replace(/`{3,}\s*council-verdict\s*\n[\s\S]*?`{3,}/g, '')
  cleaned = cleaned.replace(/`{3,}\s*council-verdict[\s\S]*$/g, '')

  return cleaned.trim()
}
