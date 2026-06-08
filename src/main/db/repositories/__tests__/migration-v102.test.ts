/**
 * Migration-upgrade test for v102 (add-usage-log).
 *
 * The fresh-install path (schema.sql via createTestDb) is covered elsewhere; this
 * exercises the v102 migration `up()` against a bare DB that has NO usage_log table.
 * Skips gracefully when the better-sqlite3 native module is unavailable.
 */
import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'

interface BareEnv {
  Database: typeof import('better-sqlite3')
  migrations: import('../../index').Migration[]
}

function trySetup(): BareEnv | null {
  try {
    process.env.NODE_ENV = 'test'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    // Probe-construct a DB so an ABI mismatch (NODE_MODULE_VERSION) surfaces here
    // and the suite skips gracefully under bare Node — it runs under Electron's ABI.
    new Database(':memory:').close()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { migrations } = require('../../index')
    return { Database, migrations }
  } catch (err) {
    console.log(
      `\n⚠ better-sqlite3 native module not compatible with current Node.js — migration-v102 test will be skipped.`
    )
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('Migration v102 (skipped — native module unavailable)', () => {
    test('usage_log table is created', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database, migrations } = env

  describe('Migration v102 — add-usage-log', () => {
    test('migration 102 exists in the exported list', () => {
      const migration = migrations.find((m) => m.version === 102)
      assert.ok(migration, 'v102 migration is registered')
      assert.equal(migration.name, 'add-usage-log')
    })

    test('up() creates usage_log table, indexes, and a row round-trips', () => {
      const migration = migrations.find((m) => m.version === 102)
      assert.ok(migration)

      // Bare DB — no schema.sql, so usage_log does not exist yet.
      const db = new Database(':memory:')
      try {
        const before = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'`)
          .get()
        assert.equal(before, undefined, 'usage_log absent before migration')

        // Run the migration inside a transaction, mirroring the runner.
        db.transaction(() => migration.up(db))()

        // Table now exists.
        const after = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='usage_log'`)
          .get() as { name: string } | undefined
        assert.ok(after, 'usage_log present after migration')
        assert.equal(after.name, 'usage_log')

        // All 4 indexes exist.
        const indexes = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='usage_log'`)
          .all() as Array<{ name: string }>
        const indexNames = indexes.map((i) => i.name)
        for (const expected of [
          'idx_usage_log_workspace',
          'idx_usage_log_feature',
          'idx_usage_log_conversation',
          'idx_usage_log_created'
        ]) {
          assert.ok(indexNames.includes(expected), `index ${expected} created`)
        }

        // A row inserts and round-trips with defaults applied.
        db.prepare(
          `INSERT INTO usage_log (feature, workspace_id, input_tokens, output_tokens, cost_cents)
           VALUES (?, ?, ?, ?, ?)`
        ).run('chat', 'ws-1', 100, 50, 7)

        const row = db
          .prepare(`SELECT feature, input_tokens, cost_cents, id, created_at FROM usage_log`)
          .get() as {
          feature: string
          input_tokens: number
          cost_cents: number
          id: string
          created_at: string
        }
        assert.equal(row.feature, 'chat')
        assert.equal(row.input_tokens, 100)
        assert.equal(row.cost_cents, 7)
        assert.ok(row.id, 'id default populated')
        assert.ok(row.created_at, 'created_at default populated')
      } finally {
        db.close()
      }
    })
  })
}
