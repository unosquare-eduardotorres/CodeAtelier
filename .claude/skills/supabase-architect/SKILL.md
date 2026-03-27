---
name: supabase-architect
description: >
  Supabase PostgreSQL + Drizzle ORM for external projects: schema design, migrations,
  RLS, pgvector, indexing, query tuning. Trigger: Supabase, Drizzle ORM, PostgreSQL,
  RLS policies, pgvector, connection pooling. NOT for Agent Studio SQLite.
---

# Supabase Architect

> **Skill version**: 1.0 (Agent Studio edition)
> **Last updated**: 2026-03-23
> **Target**: External projects using Supabase PostgreSQL + Drizzle ORM
> **Note**: Agent Studio itself uses SQLite via better-sqlite3 (see `sqlite-patterns` skill).
> This skill is for working on projects that use Supabase (e.g., MarketingHQ).

Generic Supabase/PostgreSQL database lifecycle management — schema design, migrations,
Drizzle ORM patterns, RLS policies, and performance tuning.

## Before you start

1. **Confirm the target project** — this skill is NOT for Agent Studio's own database
2. Check the project's Supabase config: `.env` or `.env.example` for `SUPABASE_URL`, keys
3. Check the schema source: look for `schema.ts` (Drizzle) or `migrations/` directory
4. Check the query layer: Drizzle ORM, raw `@supabase/supabase-js`, or both
5. Check the connection type: session pooler (port 5432) vs transaction pooler (port 6543)

## Supabase connection patterns

### Connection string formats

```
# Session pooler (long-running servers — recommended for APIs)
postgresql://postgres.PROJECT_REF:[PASSWORD]@aws-0-REGION.pooler.supabase.com:5432/postgres

# Transaction pooler (serverless/edge functions)
postgresql://postgres.PROJECT_REF:[PASSWORD]@aws-0-REGION.pooler.supabase.com:6543/postgres

# Direct connection (may not resolve on newer projects — verify DNS first)
postgresql://postgres:[PASSWORD]@db.PROJECT_REF.supabase.co:5432/postgres
```

### Environment variables

```bash
SUPABASE_URL=https://PROJECT_REF.supabase.co
SUPABASE_ANON_KEY=eyJ...          # Public, client-safe, respects RLS
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # Secret, bypasses RLS, server-only
DATABASE_URL=postgresql://...      # Direct connection for Drizzle/migrations
```

## Schema design conventions

### Primary keys

```sql
-- PostgreSQL UUID with auto-generation
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
```

### Timestamps

```sql
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### Foreign keys — always add indexes

PostgreSQL does NOT auto-index foreign keys:

```sql
ALTER TABLE tasks ADD COLUMN agent_id UUID REFERENCES agents(id);
CREATE INDEX idx_tasks_agent_id ON tasks(agent_id);  -- ALWAYS add this
```

### JSONB columns — when to use vs. normalize

**Acceptable as JSONB**: `config`, `metadata`, unstructured key-value pairs, display preferences

**Should be relational**: arrays that need querying (tools, integrations, tags)

```sql
-- If you need "which items have tag X?" — use a join table
CREATE TABLE item_tags (
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
```

## Migration conventions

### File naming

```
migrations/NNN_descriptive_name.sql
```

Sequential number, lowercase snake_case, one concern per file.

### Migration template

```sql
-- Migration: NNN_description
-- Description: What this migration does
-- Date: YYYY-MM-DD

BEGIN;

ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_field TEXT;
CREATE INDEX IF NOT EXISTS idx_my_table_new_field ON my_table(new_field);

-- Verification
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'my_table' AND column_name = 'new_field';

COMMIT;
```

### Running migrations

```bash
# Via Supabase CLI
supabase link --project-ref PROJECT_REF
supabase db push

# Via psql
psql "$DATABASE_URL" -f migrations/NNN_my_migration.sql

# Via Drizzle Kit
npx drizzle-kit generate   # Generate from schema.ts changes
npx drizzle-kit migrate    # Apply migrations
npx drizzle-kit push       # Push schema directly (dev only)
```

## Row Level Security (RLS)

### Standard policy pattern

```sql
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;

-- Service role (backend) gets full access
CREATE POLICY "Service role full access" ON my_table
  FOR ALL USING (auth.role() = 'service_role');

-- Authenticated users see their own data
-- IMPORTANT: wrap auth.uid() in subquery for caching performance
CREATE POLICY "Users see own data" ON my_table
  FOR SELECT USING (user_id = (SELECT auth.uid()));
```

### RLS debugging

```sql
SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'my_table';
```

## Performance checklist

### Find missing indexes on FK columns

```sql
SELECT tc.table_name, kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
AND NOT EXISTS (
  SELECT 1 FROM pg_indexes pi
  WHERE pi.tablename = tc.table_name
  AND pi.indexdef LIKE '%' || kcu.column_name || '%'
);
```

### Debug slow queries

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM tasks WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50;
```

### Check index usage

```sql
SELECT indexrelname, idx_scan, idx_tup_read
FROM pg_stat_user_indexes ORDER BY idx_scan ASC;
```

## Vector search (pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memories ADD COLUMN embedding vector(384);

CREATE INDEX idx_memories_embedding ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

SELECT id, content, 1 - (embedding <=> query_embedding) AS similarity
FROM memories
WHERE 1 - (embedding <=> query_embedding) > 0.5
ORDER BY embedding <=> query_embedding
LIMIT 5;
```

## Comparison: Agent Studio (SQLite) vs Supabase projects

| Aspect        | Agent Studio               | Supabase project                  |
| ------------- | -------------------------- | --------------------------------- |
| Database      | SQLite (better-sqlite3)    | PostgreSQL 15                     |
| Primary keys  | `TEXT hex(randomblob(16))` | `UUID gen_random_uuid()`          |
| Timestamps    | `TEXT datetime('now')`     | `TIMESTAMPTZ NOW()`               |
| JSON          | TEXT (json_extract)        | JSONB (native operators)          |
| Auth          | None (local desktop app)   | Supabase Auth + RLS               |
| Queries       | Synchronous prepared stmts | Async Drizzle/Supabase client     |
| Migrations    | Inline try/catch ALTER     | SQL files via CLI or Drizzle Kit  |
| Vector search | sqlite-vec or app-level    | pgvector extension                |
| Connection    | Local file                 | Session/transaction pooler        |
| Skill to use  | `sqlite-patterns`          | `supabase-architect` (this skill) |

## Reference files

- [references/supabase-patterns.md](references/supabase-patterns.md) — CLI, RLS, auth, realtime, functions, backup
- [references/drizzle-postgres.md](references/drizzle-postgres.md) — Drizzle ORM patterns, type-safe queries, drizzle-mcp live tooling
- [references/migration-to-sqlite.md](references/migration-to-sqlite.md) — PostgreSQL → SQLite conversion guide for Electron apps

## Optional: Drizzle MCP Server

For live database operations without leaving Claude Code, the `drizzle-mcp` server
(github:defrex/drizzle-mcp) provides migration generation, schema introspection,
query execution, and migration application through the MCP protocol.
See [references/drizzle-postgres.md](references/drizzle-postgres.md#drizzle-mcp-server-live-tooling) for setup.
