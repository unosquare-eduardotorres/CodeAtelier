/**
 * Test helpers for creating in-memory SQLite databases with the full schema.
 * Used by integration tests that need real DB access without Electron's app.getPath().
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Module from 'node:module'
import Database from 'better-sqlite3'

// Vite inlines `?raw` imports at build time; under tsx/Node we need
// schema.sql loaded as plain text. tsx's transformer wraps Module.load
// and bypasses require.extensions, so we:
// 1. Strip the `?raw` suffix during resolution (Node appends `=` → `?raw=`)
// 2. Pre-populate the require cache with the raw SQL text
const schemaSqlPath = resolve(__dirname, 'schema.sql')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origResolve = (Module as any)._resolveFilename
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(Module as any)._resolveFilename = function (request: string, ...args: any[]) {
  // Strip Vite's ?raw query so Node resolves the bare .sql file
  if (request.endsWith('.sql?raw')) {
    request = request.slice(0, -4) // remove '?raw'
  }
  return origResolve.call(this, request, ...args)
}

if (!require.cache[schemaSqlPath]) {
  const m = new Module(schemaSqlPath)
  m.filename = schemaSqlPath
  m.exports = readFileSync(schemaSqlPath, 'utf8')
  ;(m as unknown as { loaded: boolean }).loaded = true
  require.cache[schemaSqlPath] = m
}

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
  db.pragma('busy_timeout = 5000') // Match production busy_timeout for test parity
  db.pragma('foreign_keys = ON')

  // Lazy require to avoid triggering electron imports at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    `/tmp/test-project-${id}`
  )
  return id
}
