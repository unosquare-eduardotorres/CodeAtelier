/**
 * Diagnostic checkpoint logger for the semantic search indexing pipeline.
 *
 * Logs memory usage (RSS, heap, external, WASM) at each pipeline checkpoint.
 * When an OOM crash kills the process, the LAST checkpoint log line in the
 * log file pinpoints the exact phase where the crash occurred.
 *
 * Usage:
 *   memoryCheckpoint('PHASE_NAME', { extra: 'context' })
 *
 * Output (to electron-log file + console):
 *   [Indexing:Diag] CHECKPOINT PHASE_NAME | rss=245MB heap=120/180MB ext=5MB arraybuf=30MB | {"extra":"context"}
 */
import log from 'electron-log/main'

const MB = 1024 * 1024

/**
 * Log a named checkpoint with current memory stats.
 *
 * @param name — short ALL_CAPS label (e.g. `PREPROCESS_START`, `EMBED_BATCH_5`)
 * @param context — optional bag of numbers/strings for extra detail
 */
export function memoryCheckpoint(
  name: string,
  context?: Record<string, string | number | boolean>
): void {
  const mem = process.memoryUsage()
  const rss = (mem.rss / MB).toFixed(1)
  const heapUsed = (mem.heapUsed / MB).toFixed(1)
  const heapTotal = (mem.heapTotal / MB).toFixed(1)
  const external = (mem.external / MB).toFixed(1)
  const arrayBuffers = (mem.arrayBuffers / MB).toFixed(1)

  const ctx = context ? ` | ${JSON.stringify(context)}` : ''

  log.info(
    `[Indexing:Diag] CHECKPOINT ${name} | rss=${rss}MB heap=${heapUsed}/${heapTotal}MB ext=${external}MB arraybuf=${arrayBuffers}MB${ctx}`
  )
}
