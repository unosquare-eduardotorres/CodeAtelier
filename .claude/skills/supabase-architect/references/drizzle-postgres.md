# Drizzle ORM + PostgreSQL Patterns

> Generic Drizzle ORM patterns for Supabase PostgreSQL projects

## Setup

### Database client initialization

```typescript
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const client = postgres(process.env.DATABASE_URL!, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,  // REQUIRED when using Supabase transaction pooler (port 6543)
});

export const db = drizzle(client, { schema });
export type Database = typeof db;
```

### drizzle.config.ts

```typescript
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL || '' },
});
```

## Schema definition

### Tables

```typescript
import { pgTable, text, uuid, timestamp, jsonb, integer, real } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### Typed JSONB columns

```typescript
interface UserPreferences {
  theme: 'light' | 'dark';
  notifications: boolean;
}

// Use $type<>() to enforce shape
preferences: jsonb('preferences').$type<UserPreferences>(),
```

### Custom types (e.g., pgvector)

```typescript
import { customType } from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; driverParam: string }>({
  dataType() { return 'vector(384)'; },
  toDriver(value: number[]) { return `[${value.join(',')}]`; },
  fromDriver(value: unknown) {
    return (value as string).replace(/[\[\]]/g, '').split(',').map(Number);
  },
});
```

### Relations

```typescript
import { relations } from 'drizzle-orm';

export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));

export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
```

## Query patterns

### Select with filters

```typescript
import { eq, and, gt, desc, inArray } from 'drizzle-orm';

const activeUsers = await db.select().from(users).where(eq(users.role, 'active'));

const recentPosts = await db.select()
  .from(posts)
  .where(and(eq(posts.status, 'published'), gt(posts.createdAt, cutoff)))
  .orderBy(desc(posts.createdAt))
  .limit(50);
```

### Select specific columns

```typescript
const names = await db.select({ id: users.id, name: users.name }).from(users);
```

### Joins

```typescript
const postsWithAuthors = await db.select({
  postTitle: posts.title,
  authorName: users.name,
})
.from(posts)
.innerJoin(users, eq(posts.authorId, users.id));
```

### Relational queries (nested, type-safe)

```typescript
const userWithPosts = await db.query.users.findFirst({
  where: eq(users.id, userId),
  with: {
    posts: { where: eq(posts.status, 'published'), limit: 10 },
  },
});
```

### Insert

```typescript
const [newUser] = await db.insert(users)
  .values({ name: 'Alice', email: 'alice@example.com' })
  .returning();

// Upsert
await db.insert(users)
  .values({ id: userId, name: 'Alice' })
  .onConflictDoUpdate({ target: users.id, set: { name: 'Alice', updatedAt: new Date() } });
```

### Update

```typescript
const [updated] = await db.update(users)
  .set({ role: 'admin', updatedAt: new Date() })
  .where(eq(users.id, userId))
  .returning();
```

### Delete

```typescript
await db.delete(posts).where(eq(posts.id, postId));
```

### Transactions

```typescript
await db.transaction(async (tx) => {
  const [post] = await tx.insert(posts).values({ title: 'New Post' }).returning();
  await tx.insert(comments).values({ postId: post.id, content: 'First!' });
});
```

### Aggregations

```typescript
import { count, sum, avg, sql } from 'drizzle-orm';

const postCounts = await db.select({
  status: posts.status,
  count: count(),
}).from(posts).groupBy(posts.status);
```

## Type inference

```typescript
import type { InferSelectModel, InferInsertModel } from 'drizzle-orm';

type User = InferSelectModel<typeof users>;        // What you get FROM DB
type NewUser = InferInsertModel<typeof users>;      // What you send TO DB
type UserUpdate = Partial<InferInsertModel<typeof users>>;
```

## Repository pattern with Drizzle

```typescript
export class UserRepository {
  constructor(private db: Database) {}

  async findAll() {
    return this.db.select().from(users);
  }

  async findById(id: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user ?? null;
  }

  async update(id: string, data: Partial<typeof users.$inferInsert>) {
    const [updated] = await this.db.update(users)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    return updated;
  }
}
```

## Drizzle Kit commands

```bash
npx drizzle-kit generate   # Generate SQL migration from schema changes
npx drizzle-kit migrate    # Apply pending migrations
npx drizzle-kit push       # Push schema directly (dev only, no migration file)
npx drizzle-kit pull       # Introspect DB and generate schema.ts
npx drizzle-kit studio     # Open visual database browser
npx drizzle-kit check      # Validate migration consistency
```

## Drizzle MCP Server (live tooling)

For live database operations without leaving Claude Code:

```bash
npm install -g github:defrex/drizzle-mcp
```

### MCP configuration

```json
{
  "mcpServers": {
    "drizzle": {
      "command": "npx",
      "args": ["github:defrex/drizzle-mcp", "--config", "./drizzle.config.ts"],
      "env": { "DATABASE_URL": "postgresql://..." }
    }
  }
}
```

### Available tools

| Tool | Purpose |
|------|---------|
| `drizzle_generate_migration` | Generate migration files from schema changes |
| `drizzle_run_migrations` | Apply pending migrations |
| `drizzle_introspect_schema` | Introspect existing DB schema |
| `drizzle_execute_query` | Execute raw SQL with parameter support |

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Using raw Supabase client when Drizzle is available | Use Drizzle for type-safe queries |
| Forgetting `.returning()` on INSERT/UPDATE | Always chain `.returning()` |
| Not using transactions for multi-table writes | Wrap in `db.transaction()` |
| Using `sql.raw()` with user input | Use parameterized `sql` template literal |
| Manual type casts (`as MyType[]`) | Use `InferSelectModel<typeof table>` |
| Missing `prepare: false` on transaction pooler | Required for Supabase port 6543 |
