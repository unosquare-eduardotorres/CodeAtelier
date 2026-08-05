/**
 * memory-edges.test.ts
 *
 * Migration 137 replaced three ad-hoc places that encoded relationships
 * between facts — `superseded_by`, `merged_into`, and `memory_contradictions`
 * (which had also been overloaded as a cluster-review queue) — with one typed
 * edge table.
 *
 * These tests pin the constraint set, the backfill from all three legacy
 * sources, and the direction convention (from acts on to), because a reversed
 * edge is silently wrong rather than loudly broken.
 */

import assert from 'node:assert/strict'
import { test, describe } from '../../../services/__tests__/test-harness'
import { MEMORY_EDGE_TYPES } from '../../../../shared/types'

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
    console.log('\n⚠ better-sqlite3 native module not compatible — edge tests skipped.')
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

const env = trySetup()

if (!env) {
  describe('memory_edges (skipped — native module unavailable)', () => {
    test('edge table', () => {}, { skipReason: 'no DB' })
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

  function insertFact(db: import('better-sqlite3').Database, extra: Record<string, string> = {}): string {
    const id = `edge-${++seq}`
    db.prepare(
      `INSERT INTO memory_facts
         (id, workspace_id, category, title, content, tags, scope_paths,
          tier, confidence, source_type, status, superseded_by, merged_into)
       VALUES (?, NULL, 'convention', 'T', 'C', '[]', '[]', 0, 0.5, 'manual', 'active', ?, ?)`
    ).run(id, extra.superseded_by ?? null, extra.merged_into ?? null)
    return id
  }

  // ── Structure ─────────────────────────────────────────────────────────────

  describe('memory_edges structure', () => {
    test('the table exists with the expected edge types', () => {
      const db = createSchemaDb()
      try {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_edges'")
          .get() as { sql: string } | undefined
        assert.ok(row?.sql, 'memory_edges should exist')

        const match = /edge_type\s+IN\s*\(([^)]*)\)/i.exec(row!.sql)
        assert.ok(match, 'edge_type should carry an IN (...) CHECK')
        const allowed = match![1]
          .split(',')
          .map((s) => s.trim().replace(/^'|'$/g, ''))
          .filter(Boolean)
          .sort()

        assert.deepEqual(
          allowed,
          [...MEMORY_EDGE_TYPES].sort(),
          'the CHECK must match MemoryEdgeType or writes of a valid kind fail at the DB layer'
        )
      } finally {
        db.close()
      }
    })

    test('the same edge cannot be recorded twice', () => {
      const db = createSchemaDb()
      try {
        const a = insertFact(db)
        const b = insertFact(db)
        const stmt = db.prepare(
          `INSERT INTO memory_edges (from_id, to_id, edge_type) VALUES (?, ?, 'relates_to')`
        )
        stmt.run(a, b)
        assert.throws(() => stmt.run(a, b), /UNIQUE/i)
      } finally {
        db.close()
      }
    })

    test('an edge to a missing fact is rejected', () => {
      const db = createSchemaDb()
      try {
        const a = insertFact(db)
        assert.throws(
          () =>
            db
              .prepare(`INSERT INTO memory_edges (from_id, to_id, edge_type) VALUES (?, 'ghost', 'relates_to')`)
              .run(a),
          /FOREIGN KEY/i
        )
      } finally {
        db.close()
      }
    })

    test('deleting a fact cascades to its edges', () => {
      const db = createSchemaDb()
      try {
        const a = insertFact(db)
        const b = insertFact(db)
        db.prepare(`INSERT INTO memory_edges (from_id, to_id, edge_type) VALUES (?, ?, 'relates_to')`).run(a, b)

        db.prepare('DELETE FROM memory_facts WHERE id = ?').run(a)

        const n = (db.prepare('SELECT count(*) AS n FROM memory_edges').get() as { n: number }).n
        assert.equal(n, 0, 'a dangling edge would corrupt graph traversal')
      } finally {
        db.close()
      }
    })

    test('an unknown edge type is rejected', () => {
      const db = createSchemaDb()
      try {
        const a = insertFact(db)
        const b = insertFact(db)
        assert.throws(
          () =>
            db
              .prepare(`INSERT INTO memory_edges (from_id, to_id, edge_type) VALUES (?, ?, 'invented')`)
              .run(a, b),
          /CHECK/i
        )
      } finally {
        db.close()
      }
    })
  })

  // ── Backfill ──────────────────────────────────────────────────────────────

  describe('memory_edges backfill', () => {
    /** Replay migrations up to (but excluding) the edge migration. */
    function dbBeforeEdges(): {
      db: import('better-sqlite3').Database
      edgeMigration: import('../../index').Migration
    } {
      const db = new Database(':memory:')
      db.pragma('foreign_keys = ON')
      db.exec(SCHEMA_SQL)
      const edgeMigration = migrations.find((m) => m.name === 'memory-edges')!

      for (const migration of migrations) {
        if (migration.version >= edgeMigration.version) break
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
      return { db, edgeMigration }
    }

    test('superseded_by becomes a supersedes edge pointing new → old', () => {
      const { db, edgeMigration } = dbBeforeEdges()
      try {
        const newer = insertFact(db)
        const older = insertFact(db, { superseded_by: newer })

        edgeMigration.up(db)

        const edge = db
          .prepare("SELECT from_id, to_id FROM memory_edges WHERE edge_type = 'supersedes'")
          .get() as { from_id: string; to_id: string }

        assert.equal(edge.from_id, newer, 'the replacement is the actor')
        assert.equal(edge.to_id, older, 'the replaced fact is the target')
      } finally {
        db.close()
      }
    })

    test('merged_into becomes a supersedes edge pointing canonical → source', () => {
      const { db, edgeMigration } = dbBeforeEdges()
      try {
        const canonical = insertFact(db)
        const source = insertFact(db, { merged_into: canonical })

        edgeMigration.up(db)

        const edge = db
          .prepare("SELECT from_id, to_id FROM memory_edges WHERE edge_type = 'supersedes'")
          .get() as { from_id: string; to_id: string }

        assert.equal(edge.from_id, canonical)
        assert.equal(edge.to_id, source)
      } finally {
        db.close()
      }
    })

    test('contradictions become contradicts edges pointing new → old', () => {
      const { db, edgeMigration } = dbBeforeEdges()
      try {
        const oldFact = insertFact(db)
        const newFact = insertFact(db)
        db.prepare(
          `INSERT INTO memory_contradictions (id, old_fact_id, new_fact_id, status)
           VALUES ('c1', ?, ?, 'pending')`
        ).run(oldFact, newFact)

        edgeMigration.up(db)

        const edge = db
          .prepare("SELECT from_id, to_id FROM memory_edges WHERE edge_type = 'contradicts'")
          .get() as { from_id: string; to_id: string }

        assert.equal(edge.from_id, newFact)
        assert.equal(edge.to_id, oldFact)
      } finally {
        db.close()
      }
    })

    test('a pointer to a deleted fact does not abort the migration', () => {
      const { db, edgeMigration } = dbBeforeEdges()
      try {
        // superseded_by has no FK, so a dangling pointer is possible — and it
        // must not take the whole migration down with a FK violation.
        const orphan = insertFact(db)
        db.prepare("UPDATE memory_facts SET superseded_by = 'long-gone' WHERE id = ?").run(orphan)

        edgeMigration.up(db)

        const n = (db.prepare('SELECT count(*) AS n FROM memory_edges').get() as { n: number }).n
        assert.equal(n, 0, 'the dangling row is skipped, not inserted')
      } finally {
        db.close()
      }
    })

    test('re-running the migration does not duplicate edges', () => {
      const { db, edgeMigration } = dbBeforeEdges()
      try {
        const newer = insertFact(db)
        insertFact(db, { superseded_by: newer })

        edgeMigration.up(db)
        edgeMigration.up(db)

        const n = (db.prepare('SELECT count(*) AS n FROM memory_edges').get() as { n: number }).n
        assert.equal(n, 1)
      } finally {
        db.close()
      }
    })
  })
}
