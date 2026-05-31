/**
 * Re-export the project-level test helpers and add repository-specific convenience functions.
 * Wraps the better-sqlite3 import in try/catch for graceful degradation on Node version mismatch.
 */

export { createTestDb, seedWorkspace } from '../../test-helpers'

/**
 * Try to set up a test database. Returns null if better-sqlite3 is incompatible.
 */
export function trySetupTestDb(): { db: import('better-sqlite3').Database; wsId: string } | null {
  try {
    process.env.NODE_ENV = 'test'
    const { createTestDb, seedWorkspace } = require('../../test-helpers')
    const { _setDatabaseForTesting } = require('../../index')
    const db = createTestDb()
    _setDatabaseForTesting(db)
    const wsId = seedWorkspace(db)
    return { db, wsId }
  } catch (err) {
    console.log(
      `\n\u26a0 better-sqlite3 native module not compatible with current Node.js \u2014 DB tests will be skipped.`
    )
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

/**
 * Seed a conversation for a given workspace. Returns the conversation ID.
 */
export function seedConversation(
  db: import('better-sqlite3').Database,
  workspaceId: string,
  title = 'Test Conversation',
  mode: 'plan' | 'build' | 'danger' = 'plan'
): string {
  const row = db
    .prepare(`INSERT INTO conversations (workspace_id, title, mode) VALUES (?, ?, ?) RETURNING id`)
    .get(workspaceId, title, mode) as { id: string }
  return row.id
}
