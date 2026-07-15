/**
 * Test helpers for creating in-memory SQLite databases with the full schema.
 * Used by integration tests that need real DB access without Electron's app.getPath().
 */
import Database from 'better-sqlite3'

/**
 * Create an in-memory SQLite database with the full application schema.
 *
 * Uses the inline BASE_SCHEMA_SQL (the true v0 schema) then replays all
 * versioned migrations — the same flow production uses when schema.sql
 * isn't bundled. This avoids the schema.sql drift problem where the file
 * has columns from later migrations that break earlier table-rebuild
 * migrations (e.g. v70 messages rebuild vs v98's tool_activities_json).
 *
 * Caller is responsible for closing when done.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Lazy require to avoid triggering electron imports at module load time.
  const { SCHEMA_SQL, migrations } = require('./index') as {
    SCHEMA_SQL: string
    migrations: Array<{ version: number; name: string; up: (d: Database.Database) => void }>
  }

  // Step 1: Apply base schema (creates core tables — v0 state)
  db.exec(SCHEMA_SQL)

  // Step 2: Replay all versioned migrations.
  // Tolerates 'duplicate column name' and 'already exists' errors — same as
  // the production runMigrations() function.
  for (const migration of migrations) {
    try {
      db.transaction(() => {
        migration.up(db)
        db.pragma(`user_version = ${migration.version}`)
      })()
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (msg.includes('duplicate column name') || msg.includes('already exists')) {
        db.pragma(`user_version = ${migration.version}`)
      } else {
        throw error
      }
    }
  }

  return db
}

/**
 * Seed a workspace record so FK constraints are satisfied.
 * Returns the workspace ID.
 */
export function seedWorkspace(db: Database.Database, id = 'test-workspace-1'): string {
  db.prepare(`INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`).run(
    id,
    'Test Project',
    '/tmp/test-project'
  )
  return id
}
