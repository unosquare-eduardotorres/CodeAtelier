/**
 * Startup data retention.
 *
 * Extracted from `createWindow` for two reasons:
 *
 *  - The prune calls were unreachable from any test. The bug this fixes was a
 *    MISSING caller — `blueprint_telemetry` grew without bound because nothing
 *    pruned it — and no unit test can catch a call that does not exist inside a
 *    window-creation function.
 *  - A single `try` block let one repository's failure silently cancel the
 *    others. That is the migration-44 class of fault this codebase has history
 *    with: one table diverges while the rest are perfectly healthy. Telemetry
 *    was ordered last, so a throw from `usageLogRepository` would have disabled
 *    telemetry pruning forever, at `debug` level.
 *
 * Retention windows: events 30d; usage_log / turn_usage / blueprint_telemetry
 * 90d. The last three share a window on purpose — `blueprint_telemetry` exists
 * to be joined against `turn_usage` and `usage_log`, so a shorter retention
 * would silently truncate the older part of every historical join.
 */

import { dbLogger } from '../logger'
import {
  blueprintTelemetryRepository,
  turnUsageRepository,
  usageLogRepository
} from '../db/repositories'
import { eventLoggerService } from './event-logger.service'

const RETENTION_DAYS = { events: 30, usage: 90, telemetry: 90 } as const

/** Prune every retained table. Never throws — retention is best-effort. */
export function runStartupRetention(): void {
  // Each prune is isolated: a divergent table must not cancel its neighbours.
  const steps: [string, () => unknown][] = [
    ['events', () => eventLoggerService.prune(RETENTION_DAYS.events)],
    ['usage_log', () => usageLogRepository.pruneOlderThan(RETENTION_DAYS.usage)],
    ['turn_usage', () => turnUsageRepository.pruneOlderThan(RETENTION_DAYS.usage)],
    [
      'blueprint_telemetry',
      () => blueprintTelemetryRepository.pruneOlderThan(RETENTION_DAYS.telemetry)
    ]
  ]

  for (const [name, run] of steps) {
    try {
      run()
    } catch (error) {
      // warn, not debug: a prune that stops working is invisible until the
      // table is huge, and "invisible" is how this bug survived in the first place.
      dbLogger.warn(`[retention] prune of ${name} failed (non-critical):`, error)
    }
  }
}
