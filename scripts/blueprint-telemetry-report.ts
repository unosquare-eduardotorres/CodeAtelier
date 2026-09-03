/**
 * blueprint-telemetry-report.ts — the first READER of `blueprint_telemetry`.
 *
 * E11 landed six writers (stall, nudge, auto_retry, overload, escalation,
 * stop_loss, scheduler, config) and no readers at all: the app pruned a table
 * nothing consumed. This prints what the table was built to answer.
 *
 *   1. `countByKind()`  — how often each incident fires, across every run.
 *   2. `findByBlueprint()` — one run's narrative, oldest first, including the
 *      `config` row that says which settings produced it.
 *   3. `getBlueprintPrefixStats()` — the Gate T prefix floor, and how much of it
 *      is actually measured.
 *
 * A script rather than an IPC channel + UI: it needs no channel, no renderer
 * work, and cannot destabilise the app. If it earns its keep over a few runs,
 * promoting it to an in-app panel is a separate decision.
 *
 * ON OPENCODE RUNS, section 3 will report `measured: 0`. `prefix_tokens` is
 * NULL by design on that backend (the per-call snapshot is still open work) —
 * sections 1 and 2 are fully populated there, only the Gate T floor is not.
 *
 * Usage:
 *   npx tsx scripts/blueprint-telemetry-report.ts [--db <path>] [--blueprint <id>]
 *
 * With no `--blueprint`, the most recent run that wrote telemetry is narrated.
 */
import Database from 'better-sqlite3'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { setupElectronStub } from '../src/main/services/__tests__/electron-stub'

const DB_FILE = 'code-atelier.db'
/** Packaged store first, then the dev store — see src/main/app-identity.ts. */
const DEFAULT_DBS = ['Code Atelier', 'code-atelier'].map((name) =>
  join(homedir(), 'Library', 'Application Support', name, DB_FILE)
)

function parseArgs(): { dbPath: string | null; blueprintId?: string } {
  const argv = process.argv.slice(2)
  let dbPath: string | null = null
  let blueprintId: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') dbPath = argv[++i]
    else if (argv[i] === '--blueprint') blueprintId = argv[++i]
  }
  return { dbPath: dbPath ?? DEFAULT_DBS.find((p) => existsSync(p)) ?? null, blueprintId }
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toLocaleString()
}

function main(): void {
  const { dbPath, blueprintId } = parseArgs()
  if (!dbPath || !existsSync(dbPath)) {
    console.error(`No database found. Tried:\n  ${DEFAULT_DBS.join('\n  ')}`)
    console.error(`Pass one explicitly: --db <path>`)
    process.exit(1)
  }

  // `electron-log` and `schema.sql?raw` are resolved through the same stub the
  // unit tests use — a plain tsx process has neither.
  setupElectronStub()

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })

  // The repositories reach the DB through `getDatabase()`, which would open the
  // store read-WRITE and run migrations against it. A diagnostic must never
  // migrate the database someone is using, so the read-only handle is injected
  // instead. `_setDatabaseForTesting` is the only injection point and is gated
  // on NODE_ENV; a read-only handle makes that guard's intent (never mutate a
  // real store) strictly stronger, not weaker — any stray write throws.
  process.env.NODE_ENV = 'test'
  // Required by path and BEFORE the repositories: entering the repository
  // import cycle from the other side fails with
  // "Cannot access 'BaseRepository' before initialization".
  const { _setDatabaseForTesting } = require('../src/main/db/index')
  _setDatabaseForTesting(db)

  const { blueprintTelemetryRepository } =
    require('../src/main/db/repositories/blueprint-telemetry.repository') as typeof import('../src/main/db/repositories/blueprint-telemetry.repository')
  const { turnUsageRepository } =
    require('../src/main/db/repositories/turn-usage.repository') as typeof import('../src/main/db/repositories/turn-usage.repository')

  const userVersion = db.pragma('user_version', { simple: true }) as number
  console.log(`=== blueprint telemetry — ${dbPath} (schema v${userVersion})\n`)

  // The store is only migrated when the APP launches; this script never writes,
  // so an older store is expected rather than exceptional. Say so plainly —
  // the alternative is a bare "no such table" stack trace.
  const hasTelemetry = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='blueprint_telemetry'`)
    .get()
  if (!hasTelemetry) {
    console.log(
      `blueprint_telemetry does not exist in this store (arrives with migration 156).\n` +
        `Launch the app once against it, then re-run this report.`
    )
    db.close()
    return
  }

  // ── 1. Incident counts across every run ──
  const counts = blueprintTelemetryRepository.countByKind()
  const kinds = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) {
    console.log('No telemetry rows yet — run a blueprint BUILD phase first.\n')
    db.close()
    return
  }
  console.log('incidents by kind (all runs):')
  for (const [kind, n] of kinds) console.log(`  ${kind.padEnd(22)} ${String(n).padStart(6)}`)

  // ── 2. One run's narrative ──
  // Picking WHICH run is not a repository concern, so it is asked of the handle
  // directly; everything that reads telemetry itself goes through the repository.
  const target =
    blueprintId ??
    (
      db
        .prepare(
          `SELECT blueprint_id FROM blueprint_telemetry
           GROUP BY blueprint_id ORDER BY MAX(created_at) DESC LIMIT 1`
        )
        .get() as { blueprint_id: string } | undefined
    )?.blueprint_id

  if (target) {
    const rows = blueprintTelemetryRepository.findByBlueprint(target)
    console.log(`\nrun ${target} — ${rows.length} row(s), oldest first:`)
    for (const r of rows) {
      const where = [r.phase, r.taskId, r.attempt != null ? `attempt ${r.attempt}` : null]
        .filter(Boolean)
        .join('/')
      console.log(
        `  ${r.createdAt}  ${r.kind.padEnd(12)} ${where.padEnd(28)} ${JSON.stringify(r.data)}`
      )
    }
  }

  // ── 3. Gate T ──
  const hasPrefixColumn = (
    db.prepare(`PRAGMA table_info(turn_usage)`).all() as { name: string }[]
  ).some((c) => c.name === 'prefix_tokens')
  if (!hasPrefixColumn) {
    console.log(`\nGate T prefix floor: turn_usage.prefix_tokens absent (migration 152).`)
    db.close()
    return
  }

  const scope = blueprintId ?? undefined
  const stats = turnUsageRepository.getBlueprintPrefixStats(scope)
  console.log(`\nGate T prefix floor${scope ? ` (run ${scope})` : ' (all runs)'}:`)
  console.log(`  per-task BUILD turns : ${stats.turns}`)
  console.log(
    `  measured             : ${stats.measured}` +
      (stats.measured < stats.turns
        ? `  (${stats.turns - stats.measured} unmeasured — OpenCode records prefix_tokens as NULL)`
        : '')
  )
  console.log(
    `  min / avg / max      : ${fmt(stats.minPrefixTokens)} / ` +
      `${fmt(stats.avgPrefixTokens)} / ${fmt(stats.maxPrefixTokens)}`
  )

  db.close()
}

main()
