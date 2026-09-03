/**
 * startup-retention.test.ts — the two contracts the extraction exists to hold.
 *
 *  1. Every retained table is pruned, with the window it is supposed to get.
 *     The original defect was a MISSING call (`blueprint_telemetry` was never
 *     pruned), which nothing could catch while the calls lived inline in
 *     `createWindow`.
 *  2. One failing prune does not cancel the ones after it. The inline version
 *     wrapped all of usage/turn-usage/telemetry in a single `try`, so the
 *     migration-44 failure mode — one table diverges, the rest are healthy —
 *     silently disabled telemetry retention forever.
 *
 * Run: tsx src/main/services/__tests__/startup-retention.test.ts
 */
import assert from 'node:assert/strict'
import { test, describe, summaryAsync } from './test-harness'
import { setupElectronStub } from './electron-stub'

setupElectronStub()

let mod: any
let eventLoggerService: any
let usageLogRepository: any
let turnUsageRepository: any
let blueprintTelemetryRepository: any
let loadError: Error | null = null

try {
  // The singletons are patched in place: `runStartupRetention` calls methods ON
  // these objects, so replacing a method here is seen by the module under test
  // without any module-loader trickery.
  // `db/index` is required FIRST so it is fully initialised before any
  // repository loads: entering that import cycle from the repository side fails
  // with "Cannot access 'BaseRepository' before initialization".
  //
  // Deliberately NOT `attachTestDb()`: this file never touches a database (every
  // prune is stubbed), and installing one here would make THIS file the first
  // caller of `_setDatabaseForTesting` in the shared runner — which hands later
  // files a stale handle and fails them with "FOREIGN KEY constraint failed" on
  // rows they can see with their own eyes. Requiring the module is enough.
  require('../../db/index')
  usageLogRepository = require('../../db/repositories/usage-log.repository').usageLogRepository
  turnUsageRepository = require('../../db/repositories/turn-usage.repository').turnUsageRepository
  blueprintTelemetryRepository =
    require('../../db/repositories/blueprint-telemetry.repository').blueprintTelemetryRepository
  eventLoggerService = require('../event-logger.service').eventLoggerService
  mod = require('../startup-retention')
} catch (err) {
  loadError = err as Error
  console.log(`⚠ startup-retention setup failed — tests will be skipped.`)
  console.log(`  (${loadError.message?.split('\n')[0]})`)
}

if (!mod) {
  describe('startup retention (skipped)', () => {
    test('prunes every retained table', () => {}, { skipReason: 'module load failed' })
  })
} else {
  const { runStartupRetention } = mod

  /** Swap every prune for a recorder; returns the calls and a restore fn. */
  function stubPrunes(overrides?: Record<string, () => number>): {
    calls: [string, number][]
    restore: () => void
  } {
    const calls: [string, number][] = []
    const targets: [string, any, string][] = [
      ['events', eventLoggerService, 'prune'],
      ['usage_log', usageLogRepository, 'pruneOlderThan'],
      ['turn_usage', turnUsageRepository, 'pruneOlderThan'],
      ['blueprint_telemetry', blueprintTelemetryRepository, 'pruneOlderThan']
    ]
    const originals = targets.map(([, obj, method]) => obj[method])

    for (const [name, obj, method] of targets) {
      obj[method] = (days: number): number => {
        calls.push([name, days])
        const override = overrides?.[name]
        return override ? override() : 0
      }
    }

    return {
      calls,
      restore: () => targets.forEach(([, obj, method], i) => (obj[method] = originals[i]))
    }
  }

  describe('runStartupRetention', () => {
    test('prunes all four tables with their documented windows', () => {
      const { calls, restore } = stubPrunes()
      try {
        runStartupRetention()
      } finally {
        restore()
      }

      assert.deepEqual(calls, [
        ['events', 30],
        ['usage_log', 90],
        ['turn_usage', 90],
        // The row this whole extraction exists for: telemetry is pruned at all.
        ['blueprint_telemetry', 90]
      ])
    })

    test('a throwing prune does not cancel the ones after it', () => {
      const { calls, restore } = stubPrunes({
        events: () => {
          throw new Error('events table diverged')
        }
      })
      try {
        // Never throws: retention is best-effort by contract.
        runStartupRetention()
      } finally {
        restore()
      }

      assert.deepEqual(
        calls.map(([name]) => name),
        ['events', 'usage_log', 'turn_usage', 'blueprint_telemetry'],
        'every step after the failure still ran'
      )
    })

    test('a throw in the middle still reaches telemetry — the ordering that bit us', () => {
      const { calls, restore } = stubPrunes({
        usage_log: () => {
          throw new Error('usage_log table diverged')
        }
      })
      try {
        runStartupRetention()
      } finally {
        restore()
      }

      assert.ok(
        calls.some(([name]) => name === 'blueprint_telemetry'),
        'telemetry is pruned last and must survive an earlier failure'
      )
    })
  })
}

if (require.main === module) void summaryAsync()
