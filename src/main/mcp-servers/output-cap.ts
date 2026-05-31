/**
 * MCP Server Output Cap — prevents oversized tool results from flooding
 * the LLM context window.
 *
 * 6A-2: GitHub Issue #13574 confirms that `tool.execute.after` output mutations
 * are silently ignored for MCP tools. We must cap output at the source.
 *
 * Default cap: 30,000 chars (≈7,500 tokens). Keep the first 5,000 chars
 * (likely the most relevant header/summary) and the last portion up to the cap.
 */

/** Default maximum chars for MCP tool output */
const DEFAULT_MAX_CHARS = 30_000

/** Size of the preserved head portion */
const HEAD_SIZE = 5_000

/**
 * Truncate tool output to fit within a character budget.
 *
 * Strategy: keep the first `headSize` chars and fill the remainder with
 * the tail of the output, separated by a truncation notice.
 *
 * @param result - The raw tool output string
 * @param maxChars - Maximum allowed characters (default 30,000)
 * @returns Truncated string, or original if within budget
 */
export function truncateToolOutput(result: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (result.length <= maxChars) return result

  const separator = '\n\n[...truncated — use more targeted queries...]\n\n'
  const tailSize = maxChars - HEAD_SIZE - separator.length
  const removed = result.length - maxChars

  return (
    result.slice(0, HEAD_SIZE) +
    `\n\n[...${removed.toLocaleString()} chars truncated — use more targeted queries...]\n\n` +
    result.slice(-tailSize)
  )
}
