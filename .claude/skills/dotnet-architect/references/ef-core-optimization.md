# EF Core Query Optimization

Step-by-step workflow for detecting and fixing slow Entity Framework Core queries.

## When to use

- User reports slow EF Core queries or API endpoints
- SQL logging shows N+1 patterns or excessive query count
- Response times are degraded on data-heavy endpoints
- Code review reveals EF Core anti-patterns

## When NOT to use

- General application performance (use [performance-patterns.md](performance-patterns.md))
- Dapper or raw ADO.NET (not EF Core)
- Schema design or migration questions

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Project path | Yes | Path to solution or project with EF Core |
| DbContext class | No | Specific context to analyze |
| Slow endpoint/method | No | Known slow code path to start from |

## Workflow

### Step 1: Enable SQL logging

```bash
# Check for existing logging setup
grep -rn 'LogTo\|EnableSensitiveDataLogging\|EnableDetailedErrors' src/
grep -rn 'Microsoft.EntityFrameworkCore.Database.Command' src/
```

If not enabled, add temporarily:

```csharp
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()  // dev only — shows parameter values
    .EnableDetailedErrors();
```

Or via `appsettings.Development.json`:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

### Step 2: Detect N+1 patterns

The #1 EF Core performance killer — loading related entities in a loop.

```bash
grep -rn '\.Include(' src/         # Check for eager loading usage
grep -rn 'foreach.*await' src/     # Potential N+1 in async loops
```

Look for: `foreach` loops that call `await` on navigation properties, lazy loading proxies, missing `Include()` calls.

### Step 3: Analyze tracking mode usage

```bash
grep -rn 'AsNoTracking' src/       # Check current usage
grep -rn '\.ToListAsync\|\.FirstOrDefaultAsync\|\.SingleAsync' src/  # Find all materializations
```

**Rule:** Every read-only query must use `AsNoTracking()`.

```csharp
// Per-query
var products = await db.Products
    .AsNoTracking()
    .Where(p => p.IsActive)
    .ToListAsync(ct);

// Global default for read-heavy apps
services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString)
           .UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
```

Use `AsNoTrackingWithIdentityResolution()` when the query returns duplicate entities.

### Step 4: Evaluate query shape

Check for these anti-patterns:

| Trap | Problem | Fix |
|------|---------|-----|
| `ToList()` before `Where()` | Loads entire table into memory | Filter first: `.Where().ToList()` |
| `Count()` to check existence | Scans all rows | Use `.Any()` instead |
| `.Select()` after `.Include()` | Include is ignored with projection | Remove Include, use Select only |
| `string.Contains()` in Where | May not translate, falls to client eval | Use `EF.Functions.Like()` |
| `.ToList()` inside `Select()` | Causes nested queries | Use projection with Select all the way |

### Step 5: Apply N+1 fixes

**Eager loading with Include (JOIN):**

```csharp
var orders = await db.Orders
    .Include(o => o.Items)
    .ToListAsync(ct);
```

**Split query (separate SQL, avoids cartesian explosion):**

```csharp
var orders = await db.Orders
    .Include(o => o.Items)
    .AsSplitQuery()
    .ToListAsync(ct);
```

**Projection (best — only fetches needed columns):**

```csharp
var orderSummaries = await db.Orders
    .Select(o => new OrderSummaryDto
    {
        OrderId = o.Id,
        Total = o.Items.Sum(i => i.Price),
        ItemCount = o.Items.Count
    })
    .ToListAsync(ct);
```

### When to use Split vs Single query

| Scenario | Use |
|----------|-----|
| 1 level of Include | Single query (default) |
| Multiple Includes (cartesian risk) | `AsSplitQuery()` |
| Include with large child collections | `AsSplitQuery()` |
| Need transaction consistency | Single query |

### Step 6: Check for bulk operation opportunities (EF Core 7+)

```bash
grep -rn 'SaveChangesAsync\|SaveChanges' src/  # Find save patterns
grep -rn 'foreach.*\.Remove\|foreach.*\.Update' src/  # Fetch-then-save loops
```

```csharp
// BAD: Fetches all entities, then saves one by one
var products = await db.Products.Where(p => p.Category == "Old").ToListAsync(ct);
foreach (var p in products) p.Category = "Legacy";
await db.SaveChangesAsync(ct);

// GOOD: Single SQL UPDATE, no entity loading
await db.Products
    .Where(p => p.Category == "Old")
    .ExecuteUpdateAsync(s => s.SetProperty(p => p.Category, "Legacy"), ct);

// GOOD: Single SQL DELETE
await db.Products
    .Where(p => p.IsDiscontinued)
    .ExecuteDeleteAsync(ct);
```

### Step 7: Consider compiled queries for hot paths

For queries that execute the same shape repeatedly:

```csharp
private static readonly Func<AppDbContext, int, Task<Order?>> GetOrderById =
    EF.CompileAsyncQuery((AppDbContext db, int id) =>
        db.Orders
            .Include(o => o.Items)
            .FirstOrDefault(o => o.Id == id));

// Use — skips query compilation overhead
var order = await GetOrderById(db, orderId);
```

### Step 8: Validate fixes

1. Re-run SQL logging and compare query count before/after
2. Verify no client-side evaluation warnings in logs
3. Check response times on the affected endpoints
4. Run load test if applicable

## Raw SQL escape hatch

When LINQ can't express it efficiently:

```csharp
// SAFE: Parameterized via interpolation
var results = await db.Orders
    .FromSqlInterpolated($@"
        SELECT o.* FROM Orders o
        INNER JOIN (
            SELECT OrderId, SUM(Price) as Total
            FROM OrderItems
            GROUP BY OrderId
            HAVING SUM(Price) > {minTotal}
        ) t ON o.Id = t.OrderId")
    .AsNoTracking()
    .ToListAsync(ct);
```

**Warning:** Never use `FromSqlRaw` with string interpolation — use `FromSqlInterpolated` for parameterized queries.

## Validation checklist

- [ ] All read-only queries use `AsNoTracking()`
- [ ] No N+1 patterns (verified via SQL logging)
- [ ] Bulk operations use `ExecuteUpdate`/`ExecuteDelete` (not fetch-then-save)
- [ ] Compiled queries on identified hot paths
- [ ] No `ToList()` before `Where()`
- [ ] `Any()` used instead of `Count() > 0`
- [ ] Split queries for multiple large Includes

## Common pitfalls

| Pitfall | Solution |
|---------|----------|
| Lazy loading silently creating N+1 | Remove `Microsoft.EntityFrameworkCore.Proxies` or disable lazy loading |
| Global query filters forgotten | Check `HasQueryFilter` in model config; use `IgnoreQueryFilters()` if needed |
| `DbContext` kept alive too long | DbContext should be scoped (per-request); don't cache it |
| String interpolation in `FromSqlRaw` | SQL injection risk — use `FromSqlInterpolated` |
| Missing indexes on frequently queried columns | Add `builder.HasIndex()` in entity configuration |
| Not using `AsSplitQuery()` with multiple Includes | Cartesian explosion causes memory pressure |
