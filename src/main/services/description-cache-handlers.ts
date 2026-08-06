/**
 * Pure-logic helpers extracted from DescriptionCacheService for testability.
 *
 * These functions are side-effect-free (no DB, no FS) and handle:
 * - Cache key generation (SHA-256 hash)
 * - Batch description output parsing (numbered lines → Map)
 * - Source count aggregation (rows → { ai, heuristic, total })
 */

import { createHash } from 'node:crypto'

/**
 * Generate a deterministic cache key from a chunk's file path, symbol name, and body.
 * Identical to DescriptionCacheService.makeKey — extracted for testing.
 */
export function makeDescriptionKey(filePath: string, symbolName: string, body: string): string {
  return createHash('sha256')
    .update(filePath + symbolName + body)
    .digest('hex')
}

/**
 * Parse the numbered output lines from a batch description CLI call into a Map.
 * Expected format: "N: description text" where N is 1-based.
 *
 * @param output Raw CLI output string
 * @param maxIndex Upper bound (exclusive) for valid indices (i.e. chunk count)
 * @returns Map<0-based-index, description>
 */
export function parseBatchDescriptionOutput(output: string, maxIndex: number): Map<number, string> {
  const results = new Map<number, string>()
  for (const line of output.split('\n')) {
    const match = line.match(/^(\d+):\s*(.+)/)
    if (match) {
      const idx = parseInt(match[1]) - 1 // Convert 1-based to 0-based
      if (idx >= 0 && idx < maxIndex) {
        results.set(idx, match[2].trim())
      }
    }
  }
  return results
}

/**
 * Aggregate rows of { source, count } into a summary object.
 * Handles 'ai' and 'heuristic' source types; ignores unknown sources.
 */
export function aggregateSourceCounts(rows: Array<{ source: string; count: number }>): {
  ai: number
  heuristic: number
  total: number
} {
  let ai = 0
  let heuristic = 0
  for (const row of rows) {
    if (row.source === 'ai') ai = row.count
    else if (row.source === 'heuristic') heuristic = row.count
  }
  return { ai, heuristic, total: ai + heuristic }
}
