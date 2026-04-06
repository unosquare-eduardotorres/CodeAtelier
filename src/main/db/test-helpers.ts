/**
 * Test helpers for creating in-memory SQLite databases with the full schema.
 * Used by integration tests that need real DB access without Electron's app.getPath().
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Create an in-memory SQLite database with the full application schema.
 * Does NOT run migrations — only applies schema.sql (CREATE IF NOT EXISTS).
 * Caller is responsible for closing when done.
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // Load schema from the co-located schema.sql
  const schemaPath = join(__dirname, 'schema.sql')
  const schema = readFileSync(schemaPath, 'utf-8')
  db.exec(schema)

  return db
}

/**
 * Seed a workspace record so FK constraints are satisfied.
 * Returns the workspace ID.
 */
export function seedWorkspace(db: Database.Database, id = 'test-workspace-1'): string {
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, repo_path) VALUES (?, ?, ?)`
  ).run(id, 'Test Project', '/tmp/test-project')
  return id
}
