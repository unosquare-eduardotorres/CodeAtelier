/**
 * migration-schema-parity.test.ts — schema.sql vs the migration chain.
 *
 * WHY THIS EXISTS
 *
 * Migration 44 added `'telemetry'` to `events.category` in schema.sql and, in
 * its own comment, explicitly skipped rebuilding the table for existing installs
 * — "for simplicity (SQLite limitation)". The result is a constraint a developer
 * reading schema.sql believes exists, that holds on their fresh dev database,
 * and that does NOT hold on any upgraded install. A feature written against it
 * passes every local test and violates a CHECK in production. E11's telemetry
 * table was deliberately routed AWAY from `events` because of this.
 *
 * WHAT WAS ATTEMPTED AND DROPPED
 *
 * The obvious test — diff every table's CREATE between a schema.sql-only DB and
 * a schema.sql+migrations DB — was built first and thrown away. It reports ten
 * tables, and every one of them is the intended architecture rather than a bug:
 * schema.sql is a frozen historical BASELINE and migrations reshape it by ALTER
 * and rebuild. (`blueprint_tasks`'s own comment in schema.sql spells this out:
 * "every column added after this baseline lives in a migration, not here.") Such
 * a test would fire on every future ALTER migration and buy a permanently
 * churning allowlist in exchange for no signal. Worse, it cannot see the
 * migration-44 direction at all — schema.sql declaring something no migration
 * establishes — because both sides of that comparison include schema.sql, and
 * reconstructing an old baseline is not possible from the repo.
 *
 * WHAT IS LEFT IS WHAT IS FALSIFIABLE
 *
 *   1. Fresh install must not silently LOSE a table schema.sql declares.
 *   2. The migration-44 divergence, pinned by name so it is attributable
 *      instead of buried in a comment, and so that fixing it forces this test
 *      to be updated.
 *   3. `blueprint_telemetry` reaches BOTH fresh and upgraded installs — the
 *      failure mode migration 44 is the cautionary tale for.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'

interface ParityEnv {
  Database: typeof import('better-sqlite3')
  migrations: import('../../index').Migration[]
  SCHEMA_SQL: string
}

function trySetup(): ParityEnv | null {
  try {
    process.env.NODE_ENV = 'test'
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    const { migrations, SCHEMA_SQL } = require('../../index')
    return { Database, migrations, SCHEMA_SQL }
  } catch (err) {
    console.log(`\n⚠ better-sqlite3 native module not available — schema parity skipped.`)
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('Schema parity (skipped — native module unavailable)', () => {
    test('schema.sql agrees with the migration chain', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database, migrations, SCHEMA_SQL } = env

  /**
   * Tables schema.sql still creates that a migration deliberately drops. Each
   * entry names the reason. A table appearing here that should not is a silent
   * data-loss bug; a table missing from here fails the test.
   */
  const INTENTIONALLY_DROPPED: Record<string, string> = {
    // Superseded by the memory_facts/memory_confirmations model. schema.sql
    // still creates it so that upgrades from a pre-facts baseline have
    // something to drop; the DROP is idempotent.
    memories: 'dropped in favour of memory_facts; schema.sql keeps the baseline CREATE'
  }

  function tableNames(db: import('better-sqlite3').Database): Set<string> {
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`
      )
      .all() as { name: string }[]
    return new Set(rows.map((r) => r.name))
  }

  /** schema.sql only — the frozen baseline. */
  function schemaOnlyDb(): import('better-sqlite3').Database {
    const db = new Database(':memory:')
    db.exec(SCHEMA_SQL)
    return db
  }

  /** schema.sql + every migration — the real fresh-install shape. */
  function migratedDb(): import('better-sqlite3').Database {
    const db = new Database(':memory:')
    db.exec(SCHEMA_SQL)
    for (const m of migrations) {
      try {
        db.transaction(() => {
          m.up(db)
          db.pragma(`user_version = ${m.version}`)
        })()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // Migrations are written to be re-runnable over a current schema.sql;
        // these two are the expected no-op signals.
        if (msg.includes('duplicate column') || msg.includes('already exists')) {
          db.pragma(`user_version = ${m.version}`)
        } else {
          throw new Error(`migration ${m.version} (${m.name}) failed: ${msg}`)
        }
      }
    }
    return db
  }

  describe('schema.sql vs the migration chain', () => {
    test('no table schema.sql declares is silently lost during migration', () => {
      const before = schemaOnlyDb()
      const after = migratedDb()
      try {
        const post = tableNames(after)
        const dropped = [...tableNames(before)].filter((t) => !post.has(t))

        const unexpected = dropped.filter((t) => !(t in INTENTIONALLY_DROPPED))
        assert.deepEqual(
          unexpected,
          [],
          `a migration drops ${unexpected.join(', ')}, which schema.sql still creates. ` +
            'If that is deliberate, add it to INTENTIONALLY_DROPPED with the reason; ' +
            'otherwise a fresh install is losing a table an upgraded one keeps.'
        )

        // Keeps the list honest: an entry that no longer drops is a stale record.
        const stale = Object.keys(INTENTIONALLY_DROPPED).filter((t) => !dropped.includes(t))
        assert.deepEqual(
          stale,
          [],
          `INTENTIONALLY_DROPPED lists tables that are no longer dropped: ${stale.join(', ')}`
        )
      } finally {
        before.close()
        after.close()
      }
    })

    // The migration-44 divergence, pinned rather than fixed — rebuilding
    // `events` is its own item. The point is that it stops being invisible.
    test("events.category accepts 'telemetry' on fresh installs ONLY (migration 44)", () => {
      const db = migratedDb()
      try {
        const sql = (
          db
            .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`)
            .get() as { sql: string }
        ).sql
        assert.ok(
          sql.includes("'telemetry'"),
          "schema.sql's events CHECK should still list 'telemetry'"
        )

        const rebuildsEvents = migrations.some((m) => /events_new/i.test(m.up.toString()))
        assert.equal(
          rebuildsEvents,
          false,
          'A migration now rebuilds `events`. If it establishes the telemetry ' +
            'category for upgraded installs too, delete this test — the divergence ' +
            'migration 44 left behind is fixed, and E11 telemetry could live there.'
        )
      } finally {
        db.close()
      }
    })

    // E11 — the table that exists because of everything above. Declared in BOTH
    // places, which is precisely what migration 44 failed to do.
    test('blueprint_telemetry reaches fresh AND upgraded installs', () => {
      const before = schemaOnlyDb()
      const after = migratedDb()
      try {
        assert.ok(
          tableNames(before).has('blueprint_telemetry'),
          'missing from schema.sql — a fresh install would not get it'
        )
        assert.ok(
          tableNames(after).has('blueprint_telemetry'),
          'missing from the migration chain — an upgraded install would not get it'
        )
        assert.ok(
          migrations.some((m) => m.name === 'blueprint-telemetry'),
          'migration 156 must exist by name'
        )

        // No CHECK on `kind`, deliberately: adding a telemetry kind must never
        // require a table rebuild. That is the lesson of migration 44, applied.
        const sql = (
          after
            .prepare(
              `SELECT sql FROM sqlite_master WHERE type='table' AND name='blueprint_telemetry'`
            )
            .get() as { sql: string }
        ).sql
        assert.ok(
          !/check/i.test(sql),
          '`kind` must not be constrained by a CHECK — that is what forces rebuilds'
        )
      } finally {
        before.close()
        after.close()
      }
    })

    test('blueprint_telemetry accepts an unknown kind without a schema change', () => {
      const db = migratedDb()
      try {
        db.prepare(
          `INSERT INTO blueprint_telemetry (blueprint_id, kind, data_json) VALUES (?, ?, ?)`
        ).run('bp-1', 'some_kind_invented_next_year', '{}')
        const n = db
          .prepare(`SELECT COUNT(*) AS n FROM blueprint_telemetry`)
          .get() as { n: number }
        assert.equal(n.n, 1)
      } finally {
        db.close()
      }
    })
  })
}
