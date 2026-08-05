/**
 * memory-facts-fts.test.ts
 *
 * Migration 135 added an FTS5 index over memory_facts, kept in sync by
 * triggers rather than by repository code. Triggers were chosen precisely
 * because facts are written through a dozen paths (createFact, updateFact,
 * updateFactInPlace, archiveFact, supersedeFact, mergeFact, decayFacts, bulk
 * dedup) and a manually-synced index only has to be forgotten once to start
 * returning stale titles forever.
 *
 * These tests pin the index shape, the trigger sync on every DML kind, the
 * backfill, and the query sanitiser that keeps ordinary prose from being
 * parsed as FTS5 syntax.
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
    console.log('\n⚠ better-sqlite3 native module not compatible — FTS tests skipped.')
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('memory_facts_fts (skipped — native module unavailable)', () => {
    test('fts index', () => {}, { skipReason: 'no DB' })
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

  let factSeq = 0

  function insertFact(
    db: import('better-sqlite3').Database,
    params: { title: string; content: string; tags?: string; status?: string }
  ): string {
    const id = `fts-test-${++factSeq}`
    db.prepare(
      `INSERT INTO memory_facts
         (id, workspace_id, category, title, content, tags, scope_paths,
          tier, confidence, source_type, status)
       VALUES (?, 'ws-fts', 'convention', ?, ?, ?, '[]', 0, 0.5, 'manual', ?)`
    ).run(id, params.title, params.content, params.tags ?? '[]', params.status ?? 'active')
    return id
  }

  function ftsRowsFor(db: import('better-sqlite3').Database, id: string): number {
    return (
      db
        .prepare('SELECT count(*) AS n FROM memory_facts_fts WHERE fact_id = ?')
        .get(id) as { n: number }
    ).n
  }

  function matchIds(db: import('better-sqlite3').Database, match: string): string[] {
    return (
      db
        .prepare(
          `SELECT f.id FROM memory_facts_fts fts
             JOIN memory_facts f ON f.id = fts.fact_id
            WHERE memory_facts_fts MATCH ?
              AND f.status = 'active'
            ORDER BY rank`
        )
        .all(match) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  // ── Structure ─────────────────────────────────────────────────────────────

  describe('memory_facts_fts structure', () => {
    test('the virtual table exists after migration', () => {
      const db = createSchemaDb()
      try {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_facts_fts'")
          .get() as { sql: string } | undefined
        assert.ok(row?.sql, 'memory_facts_fts should exist')
        assert.ok(/fts5/i.test(row!.sql))
      } finally {
        db.close()
      }
    })

    test('fact_id is UNINDEXED so it does not pollute the term index', () => {
      const db = createSchemaDb()
      try {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_facts_fts'")
          .get() as { sql: string }
        assert.ok(/fact_id\s+UNINDEXED/i.test(row.sql))
      } finally {
        db.close()
      }
    })

    test('it is a standard FTS5 table, not external-content', () => {
      // memory_facts.id is TEXT, so content=/content_rowid= (which require an
      // INTEGER rowid) cannot be used here.
      const db = createSchemaDb()
      try {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_facts_fts'")
          .get() as { sql: string }
        assert.ok(!/content\s*=/i.test(row.sql), 'must not be external-content')
      } finally {
        db.close()
      }
    })

    test('all three sync triggers are installed', () => {
      const db = createSchemaDb()
      try {
        const names = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'memory_facts_fts%'")
            .all() as Array<{ name: string }>
        ).map((r) => r.name).sort()
        assert.deepEqual(names, [
          'memory_facts_fts_ad',
          'memory_facts_fts_ai',
          'memory_facts_fts_au'
        ])
      } finally {
        db.close()
      }
    })
  })

  // ── Trigger sync ──────────────────────────────────────────────────────────

  describe('memory_facts_fts trigger sync', () => {
    test('an inserted fact becomes searchable', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, {
          title: 'Invoices round half up',
          content: 'Billing totals use banker rounding'
        })
        assert.equal(ftsRowsFor(db, id), 1)
        assert.deepEqual(matchIds(db, '"invoices"'), [id])
      } finally {
        db.close()
      }
    })

    test('an updated title is reindexed, and the old text stops matching', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { title: 'Obsoletewording here', content: 'body' })
        db.prepare("UPDATE memory_facts SET title = 'Freshwording here' WHERE id = ?").run(id)

        assert.equal(ftsRowsFor(db, id), 1, 'exactly one row, not a duplicate')
        assert.deepEqual(matchIds(db, '"freshwording"'), [id])
        assert.deepEqual(matchIds(db, '"obsoletewording"'), [], 'stale term is gone')
      } finally {
        db.close()
      }
    })

    test('a deleted fact leaves no orphan index row', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { title: 'Ephemeralfact', content: 'body' })
        db.prepare('DELETE FROM memory_facts WHERE id = ?').run(id)

        assert.equal(ftsRowsFor(db, id), 0)
        assert.deepEqual(matchIds(db, '"ephemeralfact"'), [])
      } finally {
        db.close()
      }
    })

    test('archiving hides a fact from search without deleting its index row', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { title: 'Archivablefact', content: 'body' })
        db.prepare("UPDATE memory_facts SET status = 'archived' WHERE id = ?").run(id)

        assert.equal(ftsRowsFor(db, id), 1, 'status is filtered in the query, not the index')
        assert.deepEqual(matchIds(db, '"archivablefact"'), [])
      } finally {
        db.close()
      }
    })

    test('tags are searchable', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, {
          title: 'Some rule',
          content: 'body',
          tags: '["billing","invoicing"]'
        })
        assert.deepEqual(matchIds(db, '"invoicing"'), [id])
      } finally {
        db.close()
      }
    })

    test('a bulk update reindexes every affected row', () => {
      const db = createSchemaDb()
      try {
        const a = insertFact(db, { title: 'Bulkonefact', content: 'x' })
        const b = insertFact(db, { title: 'Bulktwofact', content: 'x' })
        db.prepare("UPDATE memory_facts SET content = 'reindexedbody' WHERE workspace_id = 'ws-fts'").run()

        const ids = matchIds(db, '"reindexedbody"').sort()
        assert.deepEqual(ids, [a, b].sort(), 'triggers cover paths the repository never touches')
      } finally {
        db.close()
      }
    })
  })

  // ── Backfill ──────────────────────────────────────────────────────────────

  describe('memory_facts_fts backfill', () => {
    test('facts written before the migration are indexed by it', () => {
      const db = new Database(':memory:')
      try {
        db.pragma('foreign_keys = ON')
        db.exec(SCHEMA_SQL)

        // Replay everything up to (but excluding) the FTS migration, then
        // insert a fact — as an existing installation would already have.
        const ftsMigration = migrations.find((m) => m.name === 'memory-facts-fts')
        assert.ok(ftsMigration, 'the FTS migration should exist')

        for (const migration of migrations) {
          if (migration.version >= ftsMigration!.version) break
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

        const id = 'preexisting-fact'
        db.prepare(
          `INSERT INTO memory_facts
             (id, workspace_id, category, title, content, tags, scope_paths,
              tier, confidence, source_type, status)
           VALUES (?, 'ws-fts', 'convention', 'Legacyfact title', 'legacy body', '[]', '[]',
                   0, 0.5, 'manual', 'active')`
        ).run(id)

        ftsMigration!.up(db)

        assert.equal(ftsRowsFor(db, id), 1, 'the backfill indexed the pre-existing fact')
        assert.deepEqual(matchIds(db, '"legacyfact"'), [id])
      } finally {
        db.close()
      }
    })

    test('re-running the migration does not double-index', () => {
      const db = createSchemaDb()
      try {
        const id = insertFact(db, { title: 'Idempotentfact', content: 'body' })
        const ftsMigration = migrations.find((m) => m.name === 'memory-facts-fts')!
        ftsMigration.up(db)

        assert.equal(ftsRowsFor(db, id), 1)
      } finally {
        db.close()
      }
    })
  })

  // ── Ranking ───────────────────────────────────────────────────────────────

  describe('memory_facts_fts ranking', () => {
    test('orders by BM25 relevance rather than insertion order', () => {
      const db = createSchemaDb()
      try {
        insertFact(db, { title: 'Unrelated note', content: 'mentions caching once' })
        const dense = insertFact(db, {
          title: 'Caching strategy',
          content: 'caching caching caching layers'
        })

        assert.equal(matchIds(db, '"caching"')[0], dense, 'denser match ranks first')
      } finally {
        db.close()
      }
    })
  })
}
