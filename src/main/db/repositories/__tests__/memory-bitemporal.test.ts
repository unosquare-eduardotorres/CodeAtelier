/**
 * memory-bitemporal.test.ts
 *
 * Migration 136 gave memory_facts four timestamps, separating when a fact was
 * *true of the project* (valid_from / valid_to) from when we *learned* it
 * (observed_at / recorded_at).
 *
 * Two behaviours matter and are pinned here:
 *   - superseding closes a window rather than only flipping status, so a
 *     point-in-time query can still see what was true beforehand;
 *   - observed_at can be back-dated, which is what stops a convention mined
 *     from a 2011 commit from scoring as though it were written today.
 */

import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'

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
    console.log('\n⚠ better-sqlite3 native module not compatible — bitemporal tests skipped.')
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('memory_facts bi-temporal (skipped — native module unavailable)', () => {
    test('validity columns', () => {}, { skipReason: 'no DB' })
  })
} else {
  const { Database, migrations, SCHEMA_SQL } = env

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

  let seq = 0

  function insertFact(
    db: import('better-sqlite3').Database,
    overrides: { status?: string; observedAt?: string; validTo?: string } = {}
  ): string {
    const id = `bt-${++seq}`
    db.prepare(
      `INSERT INTO memory_facts
         (id, workspace_id, category, title, content, tags, scope_paths,
          tier, confidence, source_type, status,
          valid_from, valid_to, observed_at, recorded_at)
       VALUES (?, NULL, 'convention', 'Title', 'Content', '[]', '[]', 0, 0.5, 'manual', ?,
               datetime('now'), ?, COALESCE(?, datetime('now')), datetime('now'))`
    ).run(id, overrides.status ?? 'active', overrides.validTo ?? null, overrides.observedAt ?? null)
    return id
  }

  function readFact(
    db: import('better-sqlite3').Database,
    id: string
  ): {
    status: string
    valid_from: string | null
    valid_to: string | null
    observed_at: string | null
    recorded_at: string | null
  } {
    return db
      .prepare(
        'SELECT status, valid_from, valid_to, observed_at, recorded_at FROM memory_facts WHERE id = ?'
      )
      .get(id) as never
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  describe('memory_facts bi-temporal columns', () => {
    test('all four columns exist', () => {
      const db = createSchemaDb()
      try {
        const cols = (
          db.prepare('PRAGMA table_info(memory_facts)').all() as Array<{ name: string }>
        ).map((c) => c.name)
        for (const col of ['valid_from', 'valid_to', 'observed_at', 'recorded_at']) {
          assert.ok(cols.includes(col), `${col} should exist`)
        }
      } finally {
        db.close()
      }
    })

    test('the validity index exists for the hot retrieval predicate', () => {
      const db = createSchemaDb()
      try {
        const idx = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_facts_valid'"
          )
          .get()
        assert.ok(idx, 'idx_memory_facts_valid should exist')
      } finally {
        db.close()
      }
    })
  })

  // ── Backfill ──────────────────────────────────────────────────────────────

  describe('bi-temporal backfill', () => {
    test('an active row keeps an open window; a superseded row is closed', () => {
      const db = new Database(':memory:')
      try {
        db.pragma('foreign_keys = ON')
        db.exec(SCHEMA_SQL)

        const target = migrations.find((m) => m.name === 'memory-facts-bitemporal')!
        for (const migration of migrations) {
          if (migration.version >= target.version) break
          try {
            db.transaction(() => {
              migration.up(db)
              db.pragma(`user_version = ${migration.version}`)
            })()
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.includes('duplicate column') || msg.includes('already exists')) continue
            throw error
          }
        }

        for (const [id, status] of [
          ['legacy-active', 'active'],
          ['legacy-superseded', 'superseded'],
          ['legacy-archived', 'archived']
        ]) {
          db.prepare(
            `INSERT INTO memory_facts
               (id, workspace_id, category, title, content, tags, scope_paths,
                tier, confidence, source_type, status)
             VALUES (?, NULL, 'convention', 'T', 'C', '[]', '[]', 0, 0.5, 'manual', ?)`
          ).run(id, status)
        }

        target.up(db)

        const active = readFact(db, 'legacy-active')
        assert.equal(active.valid_to, null, 'an active fact is still true')
        assert.ok(active.valid_from, 'valid_from backfilled from created_at')
        assert.ok(active.observed_at, 'observed_at backfilled from created_at')
        assert.ok(active.recorded_at, 'recorded_at backfilled from created_at')

        assert.ok(readFact(db, 'legacy-superseded').valid_to, 'superseded window is closed')
        assert.ok(readFact(db, 'legacy-archived').valid_to, 'archived window is closed')
      } finally {
        db.close()
      }
    })
  })

  // ── Window closing ────────────────────────────────────────────────────────

  describe('validity window transitions', () => {
    test('a new fact starts with an open window', () => {
      const db = createSchemaDb()
      try {
        const row = readFact(db, insertFact(db))
        assert.equal(row.valid_to, null)
        assert.ok(row.valid_from)
      } finally {
        db.close()
      }
    })

    test('superseding closes the window and keeps the row queryable', () => {
      const db = createSchemaDb()
      try {
        const oldId = insertFact(db)
        const newId = insertFact(db)

        db.prepare(
          `UPDATE memory_facts SET
             status = 'superseded',
             superseded_by = ?,
             valid_to = COALESCE(valid_to, datetime('now')),
             updated_at = datetime('now')
           WHERE id = ?`
        ).run(newId, oldId)

        const row = readFact(db, oldId)
        assert.equal(row.status, 'superseded')
        assert.ok(row.valid_to, 'the window closed rather than the row vanishing')
        assert.ok(row.valid_from, 'and it still records when it became true')
      } finally {
        db.close()
      }
    })

    test('closing an already-closed window does not move the original date', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { status: 'superseded', validTo: '2020-01-01 00:00:00' })
        db.prepare(
          `UPDATE memory_facts SET valid_to = COALESCE(valid_to, datetime('now')) WHERE id = ?`
        ).run(id)

        assert.equal(readFact(db, id).valid_to, '2020-01-01 00:00:00')
      } finally {
        db.close()
      }
    })
  })

  // ── Point-in-time queries ─────────────────────────────────────────────────

  describe('point-in-time queries', () => {
    test('the default predicate returns only currently-valid facts', () => {
      const db = createSchemaDb()
      try {
        const open = insertFact(db)
        insertFact(db, { status: 'superseded', validTo: '2020-06-01 00:00:00' })

        const ids = (
          db
            .prepare("SELECT id FROM memory_facts WHERE valid_to IS NULL AND status = 'active'")
            .all() as Array<{ id: string }>
        ).map((r) => r.id)

        assert.deepEqual(ids, [open])
      } finally {
        db.close()
      }
    })

    test('an asOf predicate sees a fact that was true then but is not now', () => {
      const db = createSchemaDb()
      try {
        const retired = insertFact(db, { status: 'superseded', validTo: '2026-06-01 00:00:00' })
        // Force a known start so the window is unambiguous.
        db.prepare("UPDATE memory_facts SET valid_from = '2020-01-01 00:00:00' WHERE id = ?").run(
          retired
        )

        const asOf = '2023-01-01 00:00:00'
        const ids = (
          db
            .prepare(
              `SELECT id FROM memory_facts
                WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`
            )
            .all(asOf, asOf) as Array<{ id: string }>
        ).map((r) => r.id)

        assert.ok(ids.includes(retired), 'the fact was true at that instant')
      } finally {
        db.close()
      }
    })

    test('an asOf before a fact existed does not return it', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db)
        db.prepare("UPDATE memory_facts SET valid_from = '2026-01-01 00:00:00' WHERE id = ?").run(
          id
        )

        const asOf = '2020-01-01 00:00:00'
        const ids = (
          db
            .prepare(
              `SELECT id FROM memory_facts
                WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`
            )
            .all(asOf, asOf) as Array<{ id: string }>
        ).map((r) => r.id)

        assert.ok(!ids.includes(id))
      } finally {
        db.close()
      }
    })
  })

  // ── observed_at ───────────────────────────────────────────────────────────

  describe('observed_at back-dating', () => {
    test('a fact can record when its source stated it, not when it was ingested', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { observedAt: '2011-03-04 10:00:00' })
        const row = readFact(db, id)

        assert.equal(row.observed_at, '2011-03-04 10:00:00', 'commit date is preserved')
        assert.notEqual(row.recorded_at, row.observed_at, 'ingestion time is tracked separately')
      } finally {
        db.close()
      }
    })

    test('observed_at defaults to now when the caller supplies nothing', () => {
      const db = createSchemaDb()
      try {
        const row = readFact(db, insertFact(db))
        assert.ok(row.observed_at, 'still populated')
        assert.equal(row.observed_at, row.recorded_at, 'a fact observed now was recorded now')
      } finally {
        db.close()
      }
    })
  })
}
