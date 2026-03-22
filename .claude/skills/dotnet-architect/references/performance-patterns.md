# .NET Performance Patterns

Step-by-step workflow for scanning C#/.NET code for performance anti-patterns and producing prioritized findings with concrete fixes.

## When to use

- Performance review or optimization pass requested
- Profiling shows hot paths needing attention
- Pre-release performance audit
- Code review with performance focus

## When NOT to use

- EF Core query issues specifically (use [ef-core-optimization.md](ef-core-optimization.md))
- MSBuild/build performance (use [msbuild-best-practices.md](msbuild-best-practices.md))
- Micro-benchmarking (suggest BenchmarkDotNet directly)

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| File/directory path | Yes | Code to scan |
| Hot path hints | No | Known hot code paths for severity escalation |
| Target framework | No | For version-specific patterns (e.g., FrozenDictionary needs .NET 8+) |

## Workflow

### Step 1: Detect code signals and select pattern categories

| Signal in code | Category |
|----------------|----------|
| `async`, `await`, `Task`, `ValueTask` | Async patterns |
| `Span<`, `Memory<`, `stackalloc`, `ArrayPool`, `string.Substring`, `.Replace(`, `.ToLower()`, `+=` in loops, `params` | Memory & strings |
| `Regex`, `[GeneratedRegex]`, `Regex.Match`, `RegexOptions.Compiled` | Regex patterns |
| `Dictionary<`, `List<`, `.ToList()`, `.Where(`, `.Select(`, LINQ methods | Collections & LINQ |
| `JsonSerializer`, `HttpClient`, `Stream`, `FileStream` | I/O & serialization |

Always check structural patterns (unsealed classes) regardless of signals.

### Step 2: Run scan recipes

```bash
# Strings & memory
grep -n '\.IndexOf("' FILE                    # Missing StringComparison
grep -n '\.Substring(' FILE                    # Substring allocations
grep -En '\.(StartsWith|EndsWith|Contains)\s*\(' FILE  # Missing StringComparison
grep -n '\.ToLower()\|\.ToUpper()' FILE        # Culture-sensitive + allocation
grep -n '\.Replace(' FILE                      # Chained Replace allocations
grep -n 'params ' FILE                         # params array allocation

# Collections & LINQ
grep -n '\.Select\|\.Where\|\.OrderBy\|\.GroupBy' FILE  # LINQ on hot path
grep -n 'new Dictionary<\|new List<' FILE      # Per-call allocation
grep -n 'static readonly Dictionary<' FILE     # FrozenDictionary candidate

# Regex
grep -n 'RegexOptions.Compiled' FILE           # Compiled regex budget
grep -n 'new Regex(' FILE                      # Per-call regex
grep -n 'GeneratedRegex' FILE                  # Positive: source-gen regex

# Structural
grep -n 'public class \|internal class ' FILE  # Unsealed classes
grep -n 'sealed class' FILE                    # Already sealed
```

### Step 3: Classify findings

| Severity | Criteria | Action |
|----------|----------|--------|
| Critical | Deadlocks, crashes, security, >10x regression | Must fix |
| Moderate | 2-10x improvement, best practice for hot paths | Should fix on hot paths |
| Info | Pattern applies but code may not be on a hot path | Consider if profiling shows impact |

### Step 4: Report findings with fixes

For each finding, provide: anti-pattern code, fix, and severity.

## Pattern catalog

### Async patterns

**Deadlock risk (Critical):**
```csharp
// BAD: Synchronous blocking on async code
var result = GetDataAsync().Result;    // Deadlock in ASP.NET
var result = GetDataAsync().GetAwaiter().GetResult(); // Same risk

// GOOD: Async all the way
var result = await GetDataAsync();
```

**ValueTask misuse (Moderate):**
```csharp
// BAD: ValueTask consumed multiple times
var task = GetValueAsync();
var a = await task;
var b = await task;  // Undefined behavior!

// GOOD: Await once, or convert to Task
var result = await GetValueAsync();
```

**ConfigureAwait in app code (Info):**
- `ConfigureAwait(false)` is for **library code only**
- In ASP.NET Core, `SynchronizationContext` is null — `ConfigureAwait(false)` is unnecessary

### Memory & strings

**String concatenation in loops (Moderate):**
```csharp
// BAD: N allocations
string result = "";
foreach (var item in items)
    result += item.ToString();

// GOOD: Single allocation
var sb = new StringBuilder();
foreach (var item in items)
    sb.Append(item);
var result = sb.ToString();

// BEST (.NET 8+): Zero intermediate allocations
var handler = new DefaultInterpolatedStringHandler();
foreach (var item in items)
    handler.AppendFormatted(item);
var result = handler.ToStringAndClear();
```

**Missing StringComparison (Moderate):**
```csharp
// BAD: Culture-sensitive comparison (slow, incorrect for identifiers)
if (name.Equals("admin")) { }
if (name.IndexOf("prefix") >= 0) { }

// GOOD: Ordinal comparison
if (name.Equals("admin", StringComparison.Ordinal)) { }
if (name.Contains("prefix", StringComparison.Ordinal)) { }
```

**ToLower/ToUpper for comparison (Moderate):**
```csharp
// BAD: Allocates new string
if (input.ToLower() == "value") { }

// GOOD: No allocation
if (input.Equals("value", StringComparison.OrdinalIgnoreCase)) { }
```

**Span for substring operations (Moderate on hot paths):**
```csharp
// BAD: Allocates
string sub = input.Substring(5, 10);

// GOOD: No allocation
ReadOnlySpan<char> sub = input.AsSpan(5, 10);
```

### Collections & LINQ

**FrozenDictionary for read-only lookups (.NET 8+, Moderate):**
```csharp
// BAD: Dictionary that is never mutated after construction
private static readonly Dictionary<string, int> Lookup = new()
{
    ["a"] = 1, ["b"] = 2, ["c"] = 3
};

// GOOD: Optimized for read-only access
private static readonly FrozenDictionary<string, int> Lookup =
    new Dictionary<string, int> { ["a"] = 1, ["b"] = 2, ["c"] = 3 }
    .ToFrozenDictionary();
```

**LINQ on hot paths (Moderate):**
```csharp
// BAD on hot paths: LINQ allocates iterators and delegates
var filtered = items.Where(x => x.IsActive).Select(x => x.Name).ToList();

// GOOD on hot paths: Manual loop with pre-allocated list
var result = new List<string>(items.Count);
foreach (var item in items)
{
    if (item.IsActive)
        result.Add(item.Name);
}
```

**Note:** Since .NET 7, LINQ `Min`/`Max`/`Sum`/`Average` are vectorized. Only optimize on measured hot paths.

### Regex patterns

**Per-call regex compilation (Moderate):**
```csharp
// BAD: Compiles regex on every call
var match = Regex.Match(input, @"\d{3}-\d{4}");

// GOOD (.NET 7+): Source-generated regex
[GeneratedRegex(@"\d{3}-\d{4}")]
private static partial Regex PhonePattern();

var match = PhonePattern().Match(input);
```

### I/O & serialization

**HttpClient per request (Critical):**
```csharp
// BAD: Socket exhaustion
using var client = new HttpClient();
var response = await client.GetAsync(url);

// GOOD: Factory-managed
public class MyService(HttpClient client)
{
    public Task<string> GetDataAsync() => client.GetStringAsync("/api/data");
}

// Registration
services.AddHttpClient<MyService>(c => c.BaseAddress = new Uri("https://api.example.com"));
```

**JSON serialization context (.NET 8+ AOT, Moderate):**
```csharp
// For AOT or performance-sensitive paths
[JsonSerializable(typeof(OrderDto))]
[JsonSerializable(typeof(List<OrderDto>))]
internal partial class AppJsonContext : JsonSerializerContext;

// Use the context
var json = JsonSerializer.Serialize(order, AppJsonContext.Default.OrderDto);
```

### Structural patterns

**Unsealed classes (Info, escalates with count):**
```csharp
// BAD: Prevents devirtualization
public class OrderService { }

// GOOD: Sealed by default
public sealed class OrderService { }
```

**Severity escalation by count:**
- 1-10 unsealed classes: Info
- 11-50: Moderate
- 50+: Moderate with elevated priority (systematic issue)

## Validation checklist

- [ ] All Critical findings addressed
- [ ] All Moderate findings on hot paths addressed
- [ ] Scan recipes ran without error
- [ ] No `.Result` or `.GetAwaiter().GetResult()` outside legacy code
- [ ] HttpClient uses `IHttpClientFactory`
- [ ] No per-call `new Regex()` — source-generated or cached

## Common pitfalls when scanning

| Pitfall | Correct approach |
|---------|-----------------|
| Flagging every Dictionary as needing FrozenDictionary | Only flag if never mutated after construction |
| Suggesting Span in async methods | Use Memory in async; Span only in sync hot paths |
| Reporting LINQ outside hot paths | Only flag in identified hot paths or tight loops |
| Suggesting ConfigureAwait(false) in app code | Only applicable in library code |
| Recommending ValueTask everywhere | Only for hot paths with frequent synchronous completion |
| Suggesting unsafe code for micro-optimizations | Safe alternatives (Span, stackalloc, ArrayPool) cover most needs |
