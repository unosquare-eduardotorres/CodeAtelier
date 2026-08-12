/**
 * memory-source-type-guard.test.ts
 *
 * Regression guard for a silent data-loss bug: `MemorySourceType` gained
 * 'bootstrap' when the bootstrap pipeline shipped, but the `source_type` CHECK
 * on `memory_facts` was last extended in migration 115 and never included it.
 * Every deterministic bootstrap write then failed with
 *   CHECK constraint failed: source_type IN (...)
 * and the per-fact try/catch in memory-extraction.service swallowed it, so the
 * docs / stack / architecture / history / structure phases reported 0 facts
 * with no visible error. Migration 132 fixed the CHECK.
 *
 * These tests fail loudly the next time the TypeScript union and the DB
 * constraint drift apart, in either direction.
 */

import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { MEMORY_SOURCE_TYPES, CONFIRMATION_SOURCE_TYPES } from '../../../../shared/types'

interface MigrationEnv {
  Database: typeof import('better-sqlite3')
  migrations: import('../../index').Migration[]
  SCHEMA_SQL: string
}

function trySetup(): MigrationEnv | null {
  try {
    process.env.NODE_ENV = 'test'
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    const { migrations, SCHEMA_SQL } = require('../../index')
    return { Database, migrations, SCHEMA_SQL }
  } catch (err) {
    console.log('\n⚠ better-sqlite3 native module not compatible — source-type guard skipped.')
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('memory source_type guard (skipped — native module unavailable)', () => {
    test('CHECK matches union', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database, migrations, SCHEMA_SQL } = env

  /** Fresh DB from base schema + full migration replay (mirrors production). */
  function createSchemaDb(): import('better-sqlite3').Database {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA_SQL)
    for (const migration of migrations) {
      try {
        db.transaction(() => {
          migration.up(db)
          db.pragma(`user_version = ${migration.version}`)
        })()
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        if (msg.includes('duplicate column') || msg.includes('already exists')) {
          db.pragma(`user_version = ${migration.version}`)
          continue
        }
        throw new Error(`Migration v${migration.version} (${migration.name}) failed: ${msg}`)
      }
    }
    return db
  }

  /** Pull the allowed values out of a `source_type ... CHECK (source_type IN (...))`. */
  function readSourceTypeCheck(db: import('better-sqlite3').Database, table: string): string[] {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) as { sql: string } | undefined
    assert.ok(row?.sql, `${table} should exist`)

    const match = /source_type[^\n]*?CHECK\s*\(\s*source_type\s+IN\s*\(([^)]*)\)/i.exec(row!.sql)
    assert.ok(match, `${table}.source_type should carry an IN (...) CHECK constraint`)

    return match![1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean)
  }

  describe('memory_facts.source_type CHECK vs MemorySourceType', () => {
    test('CHECK allows exactly the values in MEMORY_SOURCE_TYPES', () => {
      const db = createSchemaDb()
      try {
        const allowed = readSourceTypeCheck(db, 'memory_facts').sort()
        const declared = [...MEMORY_SOURCE_TYPES].sort()
        assert.deepEqual(
          allowed,
          declared,
          'memory_facts.source_type CHECK has drifted from MemorySourceType. ' +
            'Add a migration rebuilding the table (see migration 132) — a union ' +
            'value missing from the CHECK makes every write of that kind fail silently.'
        )
      } finally {
        db.close()
      }
    })

    test('every declared source type can actually be inserted', () => {
      const db = createSchemaDb()
      try {
        db.prepare(
          "INSERT INTO workspaces (id, name, repo_path) VALUES ('ws-guard','g','/tmp/g')"
        ).run()
        const stmt = db.prepare(
          `INSERT INTO memory_facts (workspace_id, category, title, content, source_type)
           VALUES (?, 'convention', ?, 'body', ?)`
        )
        for (const sourceType of MEMORY_SOURCE_TYPES) {
          stmt.run('ws-guard', `fact-${sourceType}`, sourceType)
        }
        const count = db.prepare('SELECT count(*) AS c FROM memory_facts').get() as { c: number }
        assert.equal(count.c, MEMORY_SOURCE_TYPES.length)
      } finally {
        db.close()
      }
    })

    test("'bootstrap' specifically is accepted (the original regression)", () => {
      const db = createSchemaDb()
      try {
        db.prepare(
          "INSERT INTO workspaces (id, name, repo_path) VALUES ('ws-bs','b','/tmp/b')"
        ).run()
        db.prepare(
          `INSERT INTO memory_facts (workspace_id, category, title, content, source_type)
           VALUES ('ws-bs', 'gotcha', 'bootstrap fact', 'body', 'bootstrap')`
        ).run()
        const row = db
          .prepare("SELECT source_type FROM memory_facts WHERE title = 'bootstrap fact'")
          .get() as { source_type: string }
        assert.equal(row.source_type, 'bootstrap')
      } finally {
        db.close()
      }
    })

    test('an undeclared source type is still rejected', () => {
      const db = createSchemaDb()
      try {
        db.prepare(
          "INSERT INTO workspaces (id, name, repo_path) VALUES ('ws-x','x','/tmp/x')"
        ).run()
        assert.throws(
          () =>
            db
              .prepare(
                `INSERT INTO memory_facts (workspace_id, category, title, content, source_type)
                 VALUES ('ws-x', 'gotcha', 't', 'b', 'not-a-real-source')`
              )
              .run(),
          /CHECK constraint failed/,
          'the CHECK should still reject unknown values'
        )
      } finally {
        db.close()
      }
    })
  })

  describe('memory_confirmations.source_type CHECK vs ConfirmationSourceType', () => {
    test('CHECK allows exactly the values in CONFIRMATION_SOURCE_TYPES', () => {
      const db = createSchemaDb()
      try {
        const allowed = readSourceTypeCheck(db, 'memory_confirmations').sort()
        const declared = [...CONFIRMATION_SOURCE_TYPES].sort()
        assert.deepEqual(
          allowed,
          declared,
          'memory_confirmations.source_type CHECK has drifted from ConfirmationSourceType.'
        )
      } finally {
        db.close()
      }
    })
  })

  describe('migration 132 preserves existing facts', () => {
    test('rebuild keeps rows, columns and contradictions intact', () => {
      const db = new Database(':memory:')
      try {
        db.pragma('foreign_keys = ON')
        db.exec(SCHEMA_SQL)
        const apply = (m: import('../../index').Migration): void => {
          try {
            db.transaction(() => {
              m.up(db)
              db.pragma(`user_version = ${m.version}`)
            })()
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (!/duplicate column|already exists/.test(msg)) throw error
          }
        }
        for (const m of migrations.filter((m) => m.version <= 131)) apply(m)

        db.prepare("INSERT INTO workspaces (id, name, repo_path) VALUES ('w1','w','/tmp/w')").run()
        const ins = db.prepare(
          `INSERT INTO memory_facts
             (id, workspace_id, category, title, content, tier, confidence,
              confirmation_count, status, volatile, source_type, source_ref)
           VALUES (?, 'w1', ?, ?, 'body', ?, ?, ?, 'active', ?, ?, ?)`
        )
        ins.run('f1', 'gotcha', 'Keep me', 2, 0.87, 4, 1, 'tool', 'ref-a')
        ins.run('f2', 'decision', 'Other', 0, 0.5, 0, 0, 'commit', 'ref-b')
        db.prepare(
          "INSERT INTO memory_contradictions (id, old_fact_id, new_fact_id, status) VALUES ('c1','f1','f2','pending')"
        ).run()

        const m132 = migrations.find((m) => m.version === 132)
        assert.ok(m132, 'migration 132 should exist')
        apply(m132!)

        const kept = db
          .prepare(
            'SELECT tier, confidence, confirmation_count, volatile, source_type, source_ref FROM memory_facts WHERE id = ?'
          )
          .get('f1') as Record<string, unknown>
        assert.deepEqual(kept, {
          tier: 2,
          confidence: 0.87,
          confirmation_count: 4,
          volatile: 1,
          source_type: 'tool',
          source_ref: 'ref-a'
        })

        const total = db.prepare('SELECT count(*) AS c FROM memory_facts').get() as { c: number }
        assert.equal(total.c, 2, 'no rows lost in the rebuild')

        const contradictions = db
          .prepare('SELECT count(*) AS c FROM memory_contradictions')
          .get() as { c: number }
        assert.equal(contradictions.c, 1, 'contradictions survive the FK detach/reattach')

        const bak = db
          .prepare(
            "SELECT count(*) AS c FROM sqlite_master WHERE name = 'memory_contradictions_bak'"
          )
          .get() as { c: number }
        assert.equal(bak.c, 0, 'the temporary backup table is dropped')
      } finally {
        db.close()
      }
    })
  })
}
