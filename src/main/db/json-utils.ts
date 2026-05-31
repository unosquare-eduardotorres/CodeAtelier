/**
 * Safe JSON parsing utility for database repository mapRow functions.
 *
 * SQLite stores JSON as TEXT columns. If the data is corrupted (partial write,
 * schema migration error, manual edit), a raw JSON.parse will crash the entire
 * query and brick the feature. This utility returns a typed fallback instead.
 */

import { dbLogger } from '../logger'

const log = dbLogger

/**
 * Parse a JSON string safely, returning `fallback` on null/undefined/malformed input.
 * Logs a warning on parse failure so corrupted rows surface in diagnostics
 * without crashing the application.
 */
export function safeParseJSON<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback
  try {
    return JSON.parse(json) as T
  } catch (err) {
    log.warn(`JSON parse failed for value: ${json.slice(0, 100)}…`, err)
    return fallback
  }
}
