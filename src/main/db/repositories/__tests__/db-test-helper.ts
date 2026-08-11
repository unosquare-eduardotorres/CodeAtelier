/**
 * Re-export the project-level test helpers and add repository-specific convenience functions.
 * Wraps the better-sqlite3 import in try/catch for graceful degradation on Node version mismatch.
 */

export { createTestDb, seedWorkspace } from '../../test-helpers'

/** The one in-memory database `attachTestDb()` hands out. See its doc comment. */
let sharedDb: import('better-sqlite3').Database | null = null

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
    console.log(`\n⚠ DB test setup failed — tests will be skipped.`)
    console.log(`  (${(err as Error).message.split('\n')[0]})`)
    return null
  }
}

/**
 * Attach to the test database, creating one only if nobody has yet.
 *
 * `trySetupTestDb()` installs a brand-new in-memory database GLOBALLY via
 * `_setDatabaseForTesting`. That is fine for a file run on its own and quietly
 * destructive under the shared runner: every file that calls it replaces the
 * database out from under every file that called it earlier, so those files'
 * captured `db` handles still work while the repositories they are testing read
 * from somewhere else entirely. The symptom is a suite that passes file-by-file
 * and fails wholesale.
 *
 * Files that only need *a* database (rather than a pristine one) should use this
 * instead. Workspace rows are seeded per test with unique ids, so sharing one
 * database between them is not a correctness problem.
 */
export function attachTestDb(): {
  db: import('better-sqlite3').Database
  wsId: string
} | null {
  if (sharedDb) {
    const { seedWorkspace } = require('../../test-helpers')
    return { db: sharedDb, wsId: seedWorkspace(sharedDb) }
  }

  // Deliberately NOT `getDatabase()`: with the electron stub installed that
  // happily opens a real file-backed database instead of reporting "none set",
  // which would hand back a database with no schema. A module-level handle is
  // the only thing that reliably answers "has a test database been installed".
  const ctx = trySetupTestDb()
  if (ctx) sharedDb = ctx.db
  return ctx
}

/**
 * The database the repositories are using RIGHT NOW.
 *
 * `_setDatabaseForTesting` is global and several test files call it at import
 * time, so the last one to be imported wins for the whole run — and every
 * handle captured earlier still works while pointing at a database no
 * repository reads any more. A test that seeds through a captured handle and
 * then asserts through a repository gets "FOREIGN KEY constraint failed" on a
 * workspace row it can see with its own eyes.
 *
 * Resolving at call time — inside the test rather than at import — removes the
 * ordering dependency entirely: seeding and assertion always hit the same
 * database, whichever file installed it.
 */
export function liveTestDb(): import('better-sqlite3').Database {
  const { getDatabase } = require('../../index')
  return getDatabase()
}

/**
 * Re-load a module so its repository bindings point at the REAL repositories.
 *
 * Several test files mock the repository layer by patching `Module._load`. Any
 * service module first required while that patch was active keeps the mock in
 * its import binding forever, because the require cache is keyed by path and
 * not by what was installed at the time. In the shared runner that is decided
 * by import order, so a service can arrive already bound to a mock that has
 * none of the methods it calls — surfacing as
 * "Cannot read properties of undefined (reading 'findById')" from code that is
 * perfectly correct.
 *
 * Requiring the real dependencies first and then reloading the module rebinds
 * it. The previous cache entry is put back afterwards so later files see
 * exactly what they saw before.
 *
 * Reload as a GROUP, in dependency order. Each fresh copy stays in the cache
 * while the next one loads, so a service reloaded here binds to the freshly
 * reloaded modules it depends on rather than to the stale ones. Reloading them
 * one at a time produces two live copies of the same singleton — the test
 * driving one and the code under test driving the other.
 *
 * Repositories must be listed too, and first. `setupFullMock()` intercepts
 * `Module._load` for anything matching `*.repository`, so requiring one by name
 * returns the mock however many times you ask; the interception is lifted for
 * the duration of the reload (that is what `restoreFullMock()` is for, and the
 * file that installed it is supposed to have called it already).
 *
 * The previous cache entries are put back afterwards, so later files see
 * exactly what they saw before.
 *
 * @param resolvedPaths `require.resolve(...)` from the CALLING file, dependency
 *   order first (e.g. `[track.repository, track.service, landing.service]`).
 * @returns the freshly loaded modules, in the same order.
 */
export function reloadWithRealDeps(resolvedPaths: string[]): unknown[] {
  // Lift the repository interception for the duration of the reload, then put
  // back EXACTLY the loader that was installed. Calling `restoreFullMock()` and
  // leaving it restored would disable mocking for every file imported after
  // this one in the shared runner, which silently drops thousands of tests
  // rather than failing them.

  const ModuleRef = require('node:module') as any
  const loaderDuringReload = ModuleRef._load

  try {
    const { restoreFullMock } = require('../../../services/__tests__/setup-full-mock')
    restoreFullMock()
  } catch {
    /* the mock harness is not loaded in this run — nothing to lift */
  }

  const previous = resolvedPaths.map((p) => require.cache[p])
  for (const p of resolvedPaths) delete require.cache[p]

  try {
    return resolvedPaths.map((p) => require(p))
  } finally {
    resolvedPaths.forEach((p, i) => {
      const prev = previous[i]
      if (prev) require.cache[p] = prev
      else delete require.cache[p]
    })
    ModuleRef._load = loaderDuringReload
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
