---
name: sqlite-patterns
description: >
  SQLite schema design, query optimization, better-sqlite3 patterns, and repository
  implementation for Electron desktop apps. Use when working with database schema,
  SQL queries, migrations, indexing, or data access layers in better-sqlite3 projects.
user-invocable: false
---

# SQLite Patterns for Electron Apps

> **Version**: 1.0
> **Last updated**: 2026-03-21
> **Target**: better-sqlite3 with SQLite 3.45+

## Before you start

1. Check the schema: `src/main/db/schema.sql`
2. Check existing repositories: `src/main/db/repositories/`
3. Check database initialization: `src/main/db/index.ts`
4. Confirm better-sqlite3 version: `npm ls better-sqlite3`

## Schema conventions

### Primary keys

Always use TEXT PRIMARY KEY with hex random blobs — never auto-increment integers:

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Why**: hex randomblob avoids sequential ID guessing, works across distributed systems, and avoids INTEGER overflow concerns.

### Timestamps

Always use ISO 8601 text format with `datetime('now')`:

```sql
created_at TEXT NOT NULL DEFAULT (datetime('now')),
updated_at TEXT NOT NULL DEFAULT (datetime('now'))
```

**Why**: SQLite has no native datetime type. ISO text sorts correctly, is human-readable, and works with JavaScript `new Date()` parsing.

### Foreign keys

Always enable foreign keys at connection time and define ON DELETE behavior:

```typescript
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
```

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  conversation_id TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
```

### Indexes

Create indexes for:

- Foreign key columns (SQLite does NOT auto-index these)
- Columns used in WHERE clauses
- Columns used in ORDER BY
- Composite indexes for multi-column queries (leftmost prefix rule)

```sql
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);
-- Composite: covers WHERE conversation_id = ? ORDER BY created_at
CREATE INDEX idx_messages_conv_created ON messages(conversation_id, created_at);
```

## better-sqlite3 patterns

### Prepared statements (always use)

```typescript
// ✅ Prepared statement — safe from SQL injection, cached by SQLite
const stmt = db.prepare('SELECT * FROM workspaces WHERE id = ?')
const workspace = stmt.get(id)

// ✅ Named parameters for clarity
const stmt = db.prepare('INSERT INTO workspaces (name, path) VALUES (@name, @path)')
stmt.run({ name: 'My Project', path: '/Users/dev/project' })

// ❌ NEVER interpolate user input
const bad = db.prepare(`SELECT * FROM workspaces WHERE name = '${name}'`)
```

### Transaction wrapper

Use transactions for multi-statement operations — better-sqlite3 transactions are synchronous:

```typescript
const insertMany = db.transaction((items: Item[]) => {
  const stmt = db.prepare('INSERT INTO items (name, value) VALUES (@name, @value)')
  for (const item of items) {
    stmt.run(item)
  }
})

// Usage — all-or-nothing
insertMany(items)
```

### Repository pattern

Each domain entity gets its own repository class:

```typescript
export class WorkspaceRepository {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  findAll(): Workspace[] {
    return this.db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC').all() as Workspace[]
  }

  findById(id: string): Workspace | undefined {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as Workspace | undefined
  }

  create(name: string, path: string): Workspace {
    const stmt = this.db.prepare('INSERT INTO workspaces (name, path) VALUES (?, ?) RETURNING *')
    return stmt.get(name, path) as Workspace
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }
}
```

### WAL mode (required)

Always enable WAL (Write-Ahead Logging) for concurrent read/write:

```typescript
db.pragma('journal_mode = WAL')
```

**Why**: WAL allows readers to not block writers. Essential for Electron apps where the main process writes while the renderer queries.

## Query optimization

### Use EXPLAIN QUERY PLAN

```typescript
const plan = db
  .prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE conversation_id = ?')
  .all('test-id')
console.log(plan)
// Look for: SEARCH using index (good) vs SCAN (bad)
```

### Avoid SELECT \*

Only select the columns you need:

```typescript
// ❌ Fetches all columns including large content blobs
db.prepare('SELECT * FROM messages WHERE conversation_id = ?')

// ✅ Only what the UI needs
db.prepare('SELECT id, role, created_at FROM messages WHERE conversation_id = ?')
```

### Pagination

Use keyset pagination (not OFFSET) for large result sets:

```typescript
// ❌ OFFSET skips rows — O(n) for deep pages
db.prepare('SELECT * FROM messages ORDER BY created_at LIMIT 50 OFFSET 500')

// ✅ Keyset — O(1) seek using index
db.prepare('SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC LIMIT 50')
```

### Bulk inserts

Always wrap bulk inserts in a transaction — without a transaction, each INSERT is auto-committed (slow):

```typescript
// ❌ 1000 individual commits
for (const msg of messages) {
  insertStmt.run(msg)
}

// ✅ Single transaction, single commit
const bulkInsert = db.transaction((msgs: Message[]) => {
  for (const msg of msgs) {
    insertStmt.run(msg)
  }
})
bulkInsert(messages)
```

## Migration strategy

For schema changes, use a version table and sequential migration scripts:

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

```typescript
const migrations = [
  { version: 1, sql: 'CREATE TABLE workspaces (...)' },
  { version: 2, sql: 'ALTER TABLE workspaces ADD COLUMN description TEXT' },
  { version: 3, sql: 'CREATE INDEX idx_workspaces_path ON workspaces(path)' }
]

function migrate(db: Database) {
  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as
    { v: number } | undefined
  const currentVersion = current?.v ?? 0

  const pending = migrations.filter((m) => m.version > currentVersion)
  if (pending.length === 0) return

  const applyMigration = db.transaction(() => {
    for (const m of pending) {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version)
    }
  })

  applyMigration()
}
```

## Inline Migration Pattern (Agent Studio approach)

For smaller Electron apps, migrations can be inline in the database init function rather than using a schema_version table:

```typescript
// src/main/db/index.ts
function runMigrations(db: Database) {
  // Each migration wrapped in try/catch — column may already exist
  try {
    db.exec('ALTER TABLE conversations ADD COLUMN mode TEXT NOT NULL DEFAULT "plan"')
  } catch {
    /* column exists */
  }

  try {
    db.exec('ALTER TABLE conversations ADD COLUMN session_id TEXT')
  } catch {
    /* column exists */
  }

  try {
    db.exec('ALTER TABLE messages ADD COLUMN tool_activity TEXT')
  } catch {
    /* column exists */
  }
}
```

**When to use**: < 20 tables, single developer, no rollback needs.
**When to upgrade**: multi-dev team, production deployment, rollback needed → use the schema_version table pattern above.

Key conventions:

- New tables always go in `src/main/db/schema.sql` with `CREATE TABLE IF NOT EXISTS`
- Column additions go in `runMigrations()` with try/catch wrapping
- Always call `runMigrations(db)` after `db.exec(schema)` in initialization
- Repository singletons are exported from `src/main/db/repositories/index.ts`

## Common pitfalls

| Pitfall                           | Fix                                                                |
| --------------------------------- | ------------------------------------------------------------------ |
| Foreign keys not enforced         | `PRAGMA foreign_keys = ON` at every connection                     |
| Slow bulk inserts                 | Wrap in `db.transaction()`                                         |
| OFFSET pagination on large tables | Use keyset pagination                                              |
| Missing indexes on FK columns     | Always create indexes for foreign keys                             |
| Using INTEGER autoincrement PKs   | Use `hex(randomblob(16))` TEXT PKs                                 |
| Not using WAL mode                | `PRAGMA journal_mode = WAL` at startup                             |
| String interpolation in queries   | Always use prepared statements with `?` or `@param`                |
| Forgetting RETURNING clause       | Use `RETURNING *` for INSERT/UPDATE to get the created/updated row |
