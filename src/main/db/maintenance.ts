/**
 * DB maintenance — background VACUUM to reclaim freelist pages.
 *
 * Context (v1.0.89 crash triage): the packaged store grew to 579MB while live
 * tables were only ~80MB — 454MB of that was SQLite freelist pages (116K pages)
 * left behind by deleted rows. A VACUUM rebuilds the file and returns that
 * space to the OS. No data is touched.
 *
 * Runs at most once per threshold crossing, in the background, and never while
 * a blueprint pipeline is mid-flight (VACUUM takes an exclusive lock — a
 * concurrent phase write would fail with SQLITE_BUSY).
 */
import type Database from 'better-sqlite3'
import { statSync } from 'node:fs'
import { dbLogger } from '../logger'

/** Reclaimable-bytes threshold before a VACUUM is worth the startup cost. */
export const VACUUM_THRESHOLD_BYTES = 200 * 1024 * 1024 // 200 MB

/** Page size fallback when PRAGMA page_size is unavailable. */
const DEFAULT_PAGE_SIZE = 4096

/** Set true once a VACUUM has run in this process — never run twice per launch. */
let vacuumRanThisSession = false

export interface FreelistStats {
  freelistPages: number
  pageSize: number
  reclaimableBytes: number
}

/** Read freelist stats (cheap — two pragma reads). */
export function getFreelistStats(db: Database.Database): FreelistStats {
  const freelistPages =
    (db.pragma('freelist_count', { simple: true }) as number | undefined) ?? 0
  const pageSize = (db.pragma('page_size', { simple: true }) as number | undefined) ?? DEFAULT_PAGE_SIZE
  return { freelistPages, pageSize, reclaimableBytes: freelistPages * pageSize }
}

/**
 * Run a background VACUUM if the freelist exceeds the threshold.
 *
 * Guards:
 *  - at most once per process launch
 *  - skipped entirely for standalone MCP-server processes (caller decides)
 *  - `isPipelineBusy` callback lets the caller veto the run (e.g. a blueprint
 *    phase is mid-flight); when vetoed we retry on the next launch instead.
 *
 * Scheduling is fire-and-forget with a small delay so app startup isn't blocked
 * behind the exclusive lock even for a moment.
 */
export function maybeVacuumInBackground(
  db: Database.Database,
  dbPath: string,
  isPipelineBusy: () => boolean = () => false
): void {
  if (vacuumRanThisSession) return
  vacuumRanThisSession = true

  try {
    const stats = getFreelistStats(db)
    if (stats.reclaimableBytes <= VACUUM_THRESHOLD_BYTES) {
      dbLogger.info(
        `[DB] Freelist check: ${stats.freelistPages} pages ` +
          `(${Math.round(stats.reclaimableBytes / (1024 * 1024))} MB reclaimable) — below ` +
          `${Math.round(VACUUM_THRESHOLD_BYTES / (1024 * 1024))} MB threshold, no VACUUM`
      )
      return
    }

    const sizeBefore = statSync(dbPath).size
    dbLogger.info(
      `[DB] Freelist check: ${stats.freelistPages} pages ` +
        `(${Math.round(stats.reclaimableBytes / (1024 * 1024))} MB reclaimable) — above threshold, ` +
        `scheduling background VACUUM (file is ${Math.round(sizeBefore / (1024 * 1024))} MB)`
    )

    // Delay so the renderer and services finish their initial reads first.
    setTimeout(() => {
      try {
        if (isPipelineBusy()) {
          dbLogger.info('[DB] Pipeline busy at VACUUM time — deferring to next launch')
          return
        }
        const startMs = Date.now()
        db.exec('VACUUM')
        const sizeAfter = statSync(dbPath).size
        dbLogger.info(
          `[DB] ✓ VACUUM complete in ${((Date.now() - startMs) / 1000).toFixed(1)}s — ` +
            `${Math.round(sizeBefore / (1024 * 1024))} MB → ${Math.round(sizeAfter / (1024 * 1024))} MB`
        )
      } catch (err) {
        // Never fatal — a busy DB or locked file just means we try next launch.
        dbLogger.warn('[DB] Background VACUUM failed (will retry next launch):', err)
      }
    }, 5_000)
  } catch (err) {
    dbLogger.warn('[DB] Freelist check failed:', err)
  }
}
