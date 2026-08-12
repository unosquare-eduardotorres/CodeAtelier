/**
 * MCP Server Output Cap — prevents oversized tool results from flooding
 * the LLM context window.
 *
 * 6A-2: GitHub Issue #13574 confirms that `tool.execute.after` output mutations
 * are silently ignored for MCP tools. We must cap output at the source.
 *
 * Default cap: 30,000 chars (≈7,500 tokens). Uses format-aware truncation:
 *   1. JSON arrays — trims items from the end, preserving valid JSON
 *   2. Markdown tables — trims rows from the end, preserving header
 *   3. Fallback — head/tail with truncation notice
 */

/** Default maximum chars for MCP tool output */
const DEFAULT_MAX_CHARS = 30_000

/** Size of the preserved head portion (fallback strategy) */
const HEAD_SIZE = 5_000

/**
 * Truncate tool output to fit within a character budget.
 *
 * Uses format-aware strategies to preserve structure:
 *   1. JSON with arrays → trim array items, keep valid JSON
 *   2. Markdown tables → trim rows, keep header + separator
 *   3. Fallback → head/tail with truncation notice
 *
 * @param result - The raw tool output string
 * @param maxChars - Maximum allowed characters (default 30,000)
 * @returns Truncated string, or original if within budget
 */
export function truncateToolOutput(result: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (result.length <= maxChars) return result

  // Strategy 1: JSON — trim the largest array field
  if (result.startsWith('{') || result.startsWith('[')) {
    try {
      const parsed = JSON.parse(result)
      const trimmed = trimLargestArray(parsed, maxChars)
      if (trimmed) return trimmed
    } catch {
      // Not valid JSON — fall through
    }
  }

  // Strategy 2: Markdown table — trim rows, keep header
  if (result.includes('|---')) {
    const trimmed = trimMarkdownTable(result, maxChars)
    if (trimmed) return trimmed
  }

  // Strategy 3: Fallback — head/tail
  const removed = result.length - maxChars
  const separator = `\n\n[...${removed.toLocaleString()} chars truncated — use more targeted queries...]\n\n`
  const tailSize = maxChars - HEAD_SIZE - separator.length
  return result.slice(0, HEAD_SIZE) + separator + result.slice(-tailSize)
}

/**
 * Trim the largest array in a top-level JSON object to fit within maxChars.
 *
 * Binary-searches for the right number of items to keep.
 * Returns null if no trimmable array is found.
 */
function trimLargestArray(obj: unknown, maxChars: number): string | null {
  // Handle top-level arrays directly
  if (Array.isArray(obj)) {
    if (obj.length === 0) return null
    return trimArray(obj, maxChars, (trimmedArr, omitted) => {
      const output = JSON.stringify(trimmedArr)
      return omitted > 0 ? output + `\n[...${omitted} more items omitted]` : output
    })
  }

  if (typeof obj !== 'object' || obj === null) return null

  // Find the largest array in the top-level object
  const record = obj as Record<string, unknown>
  let largestKey = ''
  let largestLen = 0
  for (const [key, val] of Object.entries(record)) {
    if (Array.isArray(val) && val.length > largestLen) {
      largestKey = key
      largestLen = val.length
    }
  }
  if (!largestKey || largestLen === 0) return null

  const arr = record[largestKey] as unknown[]

  return trimArray(
    arr,
    maxChars,
    (trimmedArr, omitted) => {
      const result = { ...record, [largestKey]: trimmedArr }
      const output = JSON.stringify(result)
      return omitted > 0 ? output + `\n[...${omitted} more items omitted]` : output
    },
    record,
    largestKey
  )
}

/**
 * Binary-search for the right number of array items to keep within maxChars.
 */
function trimArray(
  arr: unknown[],
  maxChars: number,
  format: (trimmedArr: unknown[], omitted: number) => string,
  record?: Record<string, unknown>,
  key?: string
): string | null {
  // Reserve 80 chars for the truncation notice
  const budget = maxChars - 80

  // Binary-search for the right number of items
  let lo = 1
  let hi = arr.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const trimmedArr = arr.slice(0, mid)
    const test =
      record && key ? JSON.stringify({ ...record, [key]: trimmedArr }) : JSON.stringify(trimmedArr)
    if (test.length <= budget) {
      lo = mid
    } else {
      hi = mid - 1
    }
  }

  // If even 1 item doesn't fit, fall through to other strategies
  if (lo === 0) return null

  const trimmedArr = arr.slice(0, lo)
  const omitted = arr.length - lo
  return format(trimmedArr, omitted)
}

/**
 * Trim a markdown table by removing rows from the end.
 * Preserves: any text before the table, the header row, the separator row.
 * Returns null if no table structure is found.
 */
function trimMarkdownTable(text: string, maxChars: number): string | null {
  const lines = text.split('\n')

  // Find the table separator (line with |---)
  const separatorIdx = lines.findIndex((l) => l.includes('|---'))
  if (separatorIdx < 1) return null

  // Everything before the table + header + separator
  const preTable = lines.slice(0, separatorIdx + 1).join('\n')
  const dataRows = lines.slice(separatorIdx + 1)

  // Find where the table ends (first non-table line after separator)
  const postTableStart = dataRows.findIndex((l) => l.length > 0 && !l.startsWith('|'))
  const tableRows = postTableStart >= 0 ? dataRows.slice(0, postTableStart) : dataRows
  const afterTable = postTableStart >= 0 ? '\n' + dataRows.slice(postTableStart).join('\n') : ''

  // Trim rows to fit
  let output = preTable
  let rowCount = 0
  for (const row of tableRows) {
    const candidate = output + '\n' + row + afterTable
    if (candidate.length > maxChars - 60) break
    output += '\n' + row
    rowCount++
  }

  // If we couldn't fit any rows, fall through
  if (rowCount === 0 && tableRows.length > 0) return null

  const omitted = tableRows.length - rowCount
  if (omitted > 0) {
    output += `\n| _...${omitted} more rows_ | | |`
  }
  return output + afterTable
}
