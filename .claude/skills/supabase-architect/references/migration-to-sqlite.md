# PostgreSQL → SQLite Migration Guide

> Generic guide for migrating Supabase/PostgreSQL projects to Electron/SQLite

## Migration overview

```
CURRENT                           TARGET
─────────────────────────         ─────────────────────────
Supabase PostgreSQL (cloud)  →    SQLite (local file)
@supabase/supabase-js        →    better-sqlite3
Drizzle ORM (async)          →    better-sqlite3 (sync)
Supabase Auth                →    Removed (single user)
Supabase Realtime            →    IPC events
pgvector                     →    sqlite-vec or app-level
RLS policies                 →    Removed (local = trusted)
Connection pooler            →    Direct file access
UUID primary keys            →    TEXT hex(randomblob(16))
```

## Type mapping: PostgreSQL → SQLite

| PostgreSQL | SQLite | Notes |
|-----------|--------|-------|
| `UUID` | `TEXT` | Use `hex(randomblob(16))` for defaults |
| `TEXT` | `TEXT` | Direct mapping |
| `VARCHAR(n)` | `TEXT` | SQLite ignores length constraints |
| `INTEGER` | `INTEGER` | Direct mapping |
| `REAL` / `FLOAT` | `REAL` | Direct mapping |
| `BOOLEAN` | `INTEGER` | 0/1 (SQLite has no native bool) |
| `TIMESTAMPTZ` | `TEXT` | ISO 8601 strings: `datetime('now')` |
| `JSONB` | `TEXT` | JSON stored as text, use `json()` for validation |
| `vector(N)` | See vector section | sqlite-vec or application-level |
| `SERIAL` | `INTEGER PRIMARY KEY` | Auto-increment |

## Schema conversion examples

### PostgreSQL → SQLite

```sql
-- PostgreSQL
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  is_admin BOOLEAN DEFAULT FALSE,
  config JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- SQLite equivalent
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  is_admin INTEGER NOT NULL DEFAULT 0,
  config TEXT,  -- JSON stored as text
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### CHECK constraints for enum-like columns

```sql
-- PostgreSQL might use an ENUM or just text
-- SQLite: use CHECK constraints
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY DEFAULT (hex(randomblob(16))),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority TEXT DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical'))
);
```

## JSONB → JSON text

PostgreSQL JSONB supports indexing and operators. SQLite stores JSON as plain text:

```sql
-- PostgreSQL: Query JSONB
SELECT * FROM users WHERE config->>'theme' = 'dark';
SELECT * FROM users WHERE tags ? 'admin';
SELECT * FROM users WHERE tags @> '["admin"]'::jsonb;

-- SQLite: Use json_extract() and json_each()
SELECT * FROM users WHERE json_extract(config, '$.theme') = 'dark';
SELECT u.* FROM users u, json_each(u.tags) AS t WHERE t.value = 'admin';
```

### When to normalize during migration

Convert JSONB arrays to proper tables when they're frequently queried:

```sql
-- Instead of storing tags as JSON text
CREATE TABLE IF NOT EXISTS user_tags (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (user_id, tag)
);
CREATE INDEX idx_user_tags_tag ON user_tags(tag);
```

## Vector search alternatives

### Option A: sqlite-vec (recommended)

```bash
npm install sqlite-vec
```

```typescript
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

const db = new Database('app.sqlite');
sqliteVec.load(db);

db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[384]
  );
`);

const results = db.prepare(`
  SELECT id, distance FROM embeddings
  WHERE embedding MATCH ?
  ORDER BY distance LIMIT ?
`).all(JSON.stringify(queryVector), 5);
```

### Option B: Application-level cosine similarity

For small datasets (< 10K records):

```typescript
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### Option C: Full-text search (FTS5)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS content_fts USING fts5(
  title, body,
  content=my_table,
  content_rowid=rowid
);

SELECT * FROM content_fts WHERE content_fts MATCH 'search terms' ORDER BY rank;
```

## Auth removal

Desktop Electron apps typically don't need auth. Remove:

- `@supabase/supabase-js` auth calls
- JWT validation middleware
- RLS policies (SQLite has no RLS)
- `users` table (or repurpose for local preferences)

Replace with:

```sql
CREATE TABLE IF NOT EXISTS local_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Realtime → IPC events

```typescript
// Main process — emit after writes
class MyRepository {
  constructor(private db: Database, private win: BrowserWindow) {}

  create(data: NewRecord) {
    const result = this.db.prepare('INSERT INTO my_table ...').run(data);
    this.win.webContents.send('db:my_table:changed', { type: 'insert', data });
    return result;
  }
}

// Preload
contextBridge.exposeInMainWorld('api', {
  on: {
    myTableChanged: (cb: (data: any) => void) => {
      const handler = (_: any, data: any) => cb(data);
      ipcRenderer.on('db:my_table:changed', handler);
      return () => ipcRenderer.removeListener('db:my_table:changed', handler);
    },
  },
});
```

## Credential storage in Electron

Replace database-stored credentials with OS-level secure storage:

```typescript
import { safeStorage } from 'electron';

const encrypted = safeStorage.encryptString(apiKey);
// Store as BLOB in SQLite or save to file

const decrypted = safeStorage.decryptString(encrypted);
```

Uses OS keychain (macOS Keychain, Windows Credential Locker, Linux libsecret).

## Data migration script template

```typescript
import postgres from 'postgres';
import Database from 'better-sqlite3';

const pg = postgres(process.env.DATABASE_URL!);
const sqlite = new Database('app.sqlite');

sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.exec(readFileSync('schema.sql', 'utf8'));

async function migrateTable(tableName: string) {
  const rows = await pg`SELECT * FROM ${pg(tableName)}`;
  console.log(`Migrating ${tableName}: ${rows.length} rows`);

  const columns = Object.keys(rows[0] || {});
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`
  );

  const insertAll = sqlite.transaction((data: any[]) => {
    for (const row of data) {
      stmt.run(...columns.map(c => {
        const val = row[c];
        if (val !== null && typeof val === 'object') return JSON.stringify(val);
        if (typeof val === 'boolean') return val ? 1 : 0;
        return val;
      }));
    }
  });

  insertAll(rows);
}

// Migrate in FK-dependency order
await migrateTable('users');
await migrateTable('posts');
// ... etc

await pg.end();
sqlite.close();
```

## Checklist

- [ ] Create SQLite schema with converted types
- [ ] Convert UUID defaults to hex(randomblob(16))
- [ ] Convert TIMESTAMPTZ to TEXT with datetime('now')
- [ ] Convert JSONB to TEXT (or normalize to join tables)
- [ ] Add CHECK constraints for enum-like columns
- [ ] Add all indexes (including FK columns)
- [ ] Set up vector search alternative (sqlite-vec or FTS5)
- [ ] Create data migration script
- [ ] Replace Supabase client with better-sqlite3 repositories
- [ ] Remove Supabase Auth
- [ ] Replace Realtime with IPC events
- [ ] Replace credential storage with safeStorage
- [ ] Remove @supabase/supabase-js dependency
