# Supabase Patterns Reference

> Generic Supabase PostgreSQL patterns — CLI, RLS, auth, realtime, functions, backup

## Supabase CLI essentials

### Setup

```bash
# Install
brew install supabase/tap/supabase

# Login (requires access token from Dashboard → Account → Access Tokens)
supabase login

# Link to existing project
supabase link --project-ref YOUR_PROJECT_REF

# Check status
supabase status
```

### Migration workflow

```bash
# Create a new migration
supabase migration new add_indexes_to_tasks
# → Creates supabase/migrations/TIMESTAMP_add_indexes_to_tasks.sql

# Apply migrations to remote
supabase db push

# Pull remote schema to local
supabase db pull

# Diff local schema vs remote
supabase db diff

# Reset local database (destructive)
supabase db reset

# Generate TypeScript types from database schema
supabase gen types typescript --project-id YOUR_PROJECT_REF > src/types/supabase.ts
```

## Row Level Security (RLS)

### Why RLS matters

Without RLS, the anon key gives full table access. With RLS, you define who can see what.

### Policy patterns

```sql
-- 1. Enable RLS on a table
ALTER TABLE my_table ENABLE ROW LEVEL SECURITY;

-- 2. Service role bypass (backend API needs full access)
CREATE POLICY "Service role full access"
  ON my_table FOR ALL
  USING (auth.role() = 'service_role');

-- 3. Authenticated users can read their own data
CREATE POLICY "Users read own data"
  ON my_table FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- PERFORMANCE TIP: Always wrap auth.uid() in a subquery for caching
-- PostgreSQL caches the subquery result, avoiding re-evaluation per row
-- ❌ USING (user_id = auth.uid())           -- re-evaluated per row
-- ✅ USING (user_id = (SELECT auth.uid()))  -- cached, much faster

-- 4. Only creators can update their own records
CREATE POLICY "Users update own records"
  ON my_table FOR UPDATE
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
```

### RLS debugging

```sql
-- Check which tables have RLS enabled
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- Check policies on a table
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'my_table';

-- Test a query as a specific role
SET ROLE authenticated;
SELECT * FROM my_table;  -- Should apply RLS
RESET ROLE;
```

## Supabase Auth patterns

### Frontend usage

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Auth state
const { data: { session } } = await supabase.auth.getSession();
```

### For Electron migration

Auth is typically removed in desktop apps. Single-user, no login needed.
The `users` table becomes a simple config store for local user preferences.

## Realtime subscriptions

```typescript
// Listen for changes on a table
const channel = supabase
  .channel('my-changes')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'my_table',
    filter: 'status=eq.pending'
  }, (payload) => {
    handleNewRecord(payload.new);
  })
  .subscribe();

// Cleanup
channel.unsubscribe();
```

### For Electron migration

Replace with IPC events from main process:

```typescript
// Main process — after a write
win.webContents.send('db:my_table:changed', { type: 'insert', data: newRecord });

// Renderer — via preload
window.api.on.myTableChanged((payload) => {
  handleNewRecord(payload.data);
});
```

## Database functions

### Creating functions

```sql
CREATE OR REPLACE FUNCTION my_function(param1 text, param2 int DEFAULT 10)
RETURNS TABLE (id uuid, name text)
LANGUAGE plpgsql
SECURITY DEFINER  -- Runs with owner privileges, bypasses RLS
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT t.id, t.name
  FROM my_table t
  WHERE t.role = param1
  LIMIT param2;
END;
$$;
```

**SECURITY DEFINER**: bypasses RLS (for service-level queries).
**SECURITY INVOKER** (default): respects the caller's RLS policies.

## Connection pooling

### Session mode (port 5432)

One server connection per client. Supports all PostgreSQL features: prepared statements,
LISTEN/NOTIFY, temp tables. Best for long-running servers.

### Transaction mode (port 6543)

Shares connections between clients at transaction boundaries. Higher throughput but
no prepared statements, no session-level features. Best for serverless/edge.

**Critical for Drizzle**: When using transaction pooler, set `prepare: false` in the
postgres.js client config.

## Backup strategy

```bash
# Export schema
supabase db dump --project-ref PROJECT_REF > backup_schema.sql

# Export data
supabase db dump --project-ref PROJECT_REF --data-only > backup_data.sql

# Export specific table
supabase db dump --project-ref PROJECT_REF --data-only \
  --schema public --table my_table > my_table_backup.sql
```

## Best practices for AI agents

1. **Use service_role key** for agent operations — bypasses RLS, full access
2. **Wrap multi-step operations in transactions** — don't leave partial state
3. **Add explicit timeouts** on long-running queries
4. **Log all write operations** — maintain an audit trail
5. **Use parameterized queries** — prevent accidental injection
6. **Always use LIMIT** — especially for agents querying large tables
7. **Prefer read replicas** for analytics queries (if available)
