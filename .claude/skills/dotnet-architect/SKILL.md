---
name: dotnet-architect
description: >
  Comprehensive .NET/C# architecture skill for backend development. Use for ANY .NET work including
  ASP.NET Core Web API design, Entity Framework Core data access, C# coding patterns, Clean Architecture,
  dependency injection, NuGet package management, MSBuild project configuration, performance optimization,
  unit testing, and .NET version migrations. Trigger when the user mentions .NET, C#, ASP.NET, EF Core,
  NuGet, MSBuild, xUnit, MSTest, LINQ, async/await, middleware, dependency injection, Clean Architecture,
  CQRS, Domain-Driven Design, or any backend API development in the .NET ecosystem.
  Also trigger for .NET upgrade migrations (net8.0 to net9.0/net10.0), build diagnostics, performance
  profiling, or CI/CD pipeline configuration for .NET projects.
---

# .NET Architect

> **Skill version**: 1.0
> **Last updated**: 2026-03-21
> **Target .NET versions**: .NET 8 / 9 / 10
> **C# language versions**: C# 12 / 13 / 14
> **Next review date**: 2026-06-21 (quarterly, or on .NET major release)

Architect, build, and maintain production-grade .NET backend systems with modern best practices.

## Before you start

1. Check the project's .NET SDK version: `dotnet --version`. These instructions target .NET 8+.
2. Identify the project structure: solution file (`.sln`/`.slnx`), `Directory.Build.props`, `global.json`.
3. Confirm the application type: Web API, Worker Service, Console, Class Library.
4. Check for existing patterns: DI registration approach, folder structure, naming conventions.

## Project structure

Always scaffold .NET projects following Clean Architecture with clear layer separation:

```
MyApp/
├── src/
│   ├── MyApp.Domain/              # Entities, value objects, domain events, interfaces
│   │   ├── Entities/
│   │   ├── ValueObjects/
│   │   ├── Events/
│   │   ├── Exceptions/
│   │   └── Interfaces/            # Repository & service contracts
│   ├── MyApp.Application/         # Use cases, DTOs, validators, CQRS handlers
│   │   ├── Common/
│   │   │   ├── Behaviors/         # MediatR pipeline behaviors
│   │   │   ├── Interfaces/
│   │   │   └── Models/
│   │   ├── Features/              # Grouped by domain feature
│   │   │   └── Orders/
│   │   │       ├── Commands/
│   │   │       └── Queries/
│   │   └── DependencyInjection.cs
│   ├── MyApp.Infrastructure/      # EF Core, external services, file system
│   │   ├── Data/
│   │   │   ├── AppDbContext.cs
│   │   │   ├── Configurations/    # EF Core entity configurations
│   │   │   ├── Migrations/
│   │   │   └── Repositories/
│   │   ├── Services/
│   │   └── DependencyInjection.cs
│   └── MyApp.Api/                 # ASP.NET Core host, controllers/endpoints, middleware
│       ├── Controllers/           # or Endpoints/ for minimal APIs
│       ├── Middleware/
│       ├── Filters/
│       └── Program.cs
├── tests/
│   ├── MyApp.Domain.Tests/
│   ├── MyApp.Application.Tests/
│   ├── MyApp.Infrastructure.Tests/
│   └── MyApp.Api.Tests/
├── Directory.Build.props          # Shared MSBuild properties
├── Directory.Packages.props       # Central Package Management
├── global.json
└── MyApp.sln
```

Key rules:

- **Domain has ZERO dependencies** on other project layers or NuGet packages (except primitives).
- **Application depends only on Domain.** No references to Infrastructure or EF Core.
- **Infrastructure implements Domain interfaces.** All external concerns live here.
- **Api is the composition root.** DI wiring happens here via `DependencyInjection.cs` extension methods.
- Every layer has its own test project.

## ASP.NET Core Web API

### Minimal API endpoints (preferred for new projects)

```csharp
// Organize endpoints by feature using extension methods
public static class OrderEndpoints
{
    public static IEndpointRouteBuilder MapOrderEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/orders")
            .WithTags("Orders")
            .RequireAuthorization();

        group.MapGet("/", GetOrders).WithName("GetOrders");
        group.MapGet("/{id:int}", GetOrderById).WithName("GetOrderById");
        group.MapPost("/", CreateOrder).WithName("CreateOrder");
        return app;
    }

    private static async Task<Results<Ok<OrderDto>, NotFound>> GetOrderById(
        int id,
        IMediator mediator,
        CancellationToken ct)
    {
        var result = await mediator.Send(new GetOrderByIdQuery(id), ct);
        return result is not null ? TypedResults.Ok(result) : TypedResults.NotFound();
    }
}
```

### Controller-based APIs (when team prefers)

```csharp
[ApiController]
[Route("api/[controller]")]
[Produces("application/json")]
public sealed class OrdersController(IMediator mediator) : ControllerBase
{
    [HttpGet("{id:int}")]
    [ProducesResponseType<OrderDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetById(int id, CancellationToken ct)
    {
        var result = await mediator.Send(new GetOrderByIdQuery(id), ct);
        return result is not null ? Ok(result) : NotFound();
    }
}
```

### Middleware pipeline and error handling

**Middleware order matters** — ExceptionHandler → HSTS/HTTPS → StaticFiles → Routing → CORS → Auth → Custom → Endpoints.

**Error handling** — always use `ProblemDetails` (RFC 7807) for consistent API error responses with `traceId`.

For full code examples of the correct middleware order and ProblemDetails exception handler, see [references/aspnet-patterns.md](references/aspnet-patterns.md).

## Entity Framework Core

### DbContext configuration

```csharp
public sealed class AppDbContext(DbContextOptions<AppDbContext> options)
    : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Apply all IEntityTypeConfiguration from the assembly
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);
    }
}
```

### Entity configuration (separate files, not in OnModelCreating)

```csharp
internal sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> builder)
    {
        builder.HasKey(o => o.Id);
        builder.Property(o => o.Total).HasPrecision(18, 2);
        builder.HasMany(o => o.Items).WithOne().HasForeignKey(i => i.OrderId);
        builder.HasIndex(o => o.CreatedAt);
    }
}
```

### Query optimization essentials

For detailed EF Core query optimization patterns including N+1 detection, tracking modes, compiled queries, and common traps, see [references/ef-core-optimization.md](references/ef-core-optimization.md).

**Critical rules (always follow):**

- Use `AsNoTracking()` for all read-only queries
- Use `Include()` or `Select()` projections to avoid N+1 queries
- Use `AsSplitQuery()` when including multiple large collections
- Use `Any()` instead of `Count() > 0` for existence checks
- Use `ExecuteUpdateAsync`/`ExecuteDeleteAsync` (EF Core 7+) for bulk operations
- Never call `ToList()` before `Where()` — filter first, materialize last

## Dependency injection

### Registration patterns

```csharp
// In each layer's DependencyInjection.cs
public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        // DbContext — scoped by default (correct for per-request lifetime)
        services.AddDbContext<AppDbContext>(options =>
            options.UseSqlServer(
                configuration.GetConnectionString("Default"),
                sqlOptions => sqlOptions.EnableRetryOnFailure(3)));

        // Repositories
        services.AddScoped<IOrderRepository, OrderRepository>();

        // HttpClient with resilience
        services.AddHttpClient<IExternalApi, ExternalApiClient>(client =>
        {
            client.BaseAddress = new Uri(configuration["ExternalApi:BaseUrl"]!);
            client.Timeout = TimeSpan.FromSeconds(30);
        })
        .AddStandardResilienceHandler();

        return services;
    }
}
```

### Lifetime rules

| Lifetime      | Use for                                   | Never for                                      |
| ------------- | ----------------------------------------- | ---------------------------------------------- |
| **Singleton** | Stateless services, caches, configuration | DbContext, HttpClient (use factory)            |
| **Scoped**    | DbContext, repositories, unit of work     | Services injected into singletons              |
| **Transient** | Lightweight stateless operations          | Expensive objects, IDisposable without cleanup |

**Critical rule:** Never inject a scoped service into a singleton — this causes a captive dependency. Use `IServiceScopeFactory` if a singleton needs scoped services.

## C# modern patterns

### Async/await best practices

```csharp
// DO: Use async all the way, pass CancellationToken
public async Task<Order> GetOrderAsync(int id, CancellationToken ct = default)
{
    return await _context.Orders
        .AsNoTracking()
        .FirstOrDefaultAsync(o => o.Id == id, ct)
        ?? throw new NotFoundException(nameof(Order), id);
}

// DO: Use ValueTask for hot paths that often complete synchronously
public ValueTask<CachedItem?> GetFromCacheAsync(string key)
{
    return _cache.TryGetValue(key, out var item)
        ? new ValueTask<CachedItem?>(item)
        : new ValueTask<CachedItem?>(LoadFromStoreAsync(key));
}

// DON'T: async void (except event handlers)
// DON'T: .Result or .Wait() — causes deadlocks
// DON'T: ConfigureAwait(false) in application code — only in libraries
```

### Record types for DTOs and value objects

```csharp
// Immutable DTO
public sealed record OrderDto(int Id, decimal Total, DateTimeOffset CreatedAt);

// Value object with validation
public sealed record Money
{
    public decimal Amount { get; }
    public string Currency { get; }

    public Money(decimal amount, string currency)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(amount);
        ArgumentException.ThrowIfNullOrWhiteSpace(currency);
        Amount = amount;
        Currency = currency.ToUpperInvariant();
    }
}
```

### Pattern matching

```csharp
// Exhaustive switch expressions
public decimal CalculateDiscount(Customer customer) => customer.Tier switch
{
    CustomerTier.Standard => 0m,
    CustomerTier.Silver => 0.05m,
    CustomerTier.Gold => 0.10m,
    CustomerTier.Platinum => 0.15m,
    _ => throw new UnreachableException($"Unknown tier: {customer.Tier}")
};
```

## NuGet and MSBuild

### Central Package Management (required for multi-project solutions)

```xml
<!-- Directory.Packages.props at repo root -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="9.0.0" />
    <PackageVersion Include="MediatR" Version="12.4.0" />
    <PackageVersion Include="FluentValidation" Version="11.9.0" />
    <PackageVersion Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>
```

### Directory.Build.props (shared properties)

```xml
<!-- Directory.Build.props at repo root -->
<Project>
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <LangVersion>latest</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
```

For MSBuild anti-patterns, project modernization, and build optimization, see [references/msbuild-best-practices.md](references/msbuild-best-practices.md).

## Testing

### Test structure with xUnit

```csharp
public sealed class OrderServiceTests
{
    private readonly Mock<IOrderRepository> _repositoryMock = new();
    private readonly OrderService _sut;

    public OrderServiceTests()
    {
        _sut = new OrderService(_repositoryMock.Object);
    }

    [Fact]
    public async Task CreateOrder_WithValidInput_ReturnsOrderId()
    {
        // Arrange
        var command = new CreateOrderCommand("Product A", 2);
        _repositoryMock
            .Setup(r => r.AddAsync(It.IsAny<Order>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Order { Id = 42 });

        // Act
        var result = await _sut.CreateOrderAsync(command, CancellationToken.None);

        // Assert
        Assert.Equal(42, result);
        _repositoryMock.Verify(
            r => r.AddAsync(It.Is<Order>(o => o.Quantity == 2), It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task CreateOrder_WithInvalidQuantity_ThrowsValidationException(int quantity)
    {
        var command = new CreateOrderCommand("Product A", quantity);
        await Assert.ThrowsAsync<ValidationException>(
            () => _sut.CreateOrderAsync(command, CancellationToken.None));
    }
}
```

For comprehensive testing patterns including MSTest, data-driven tests, integration testing with WebApplicationFactory, and test anti-patterns, see [references/testing-patterns.md](references/testing-patterns.md).

## Performance

### Critical performance rules

1. **Seal classes by default** — unsealed classes prevent devirtualization
2. **Use `Span<T>` and `Memory<T>`** for hot-path string/buffer operations
3. **Prefer `FrozenDictionary`/`FrozenSet`** (.NET 8+) for read-only lookup collections
4. **Use `ArrayPool<T>`** instead of allocating arrays in loops
5. **Use `StringComparison.Ordinal`** for all non-user-facing string comparisons
6. **Avoid LINQ on hot paths** — use `foreach` with pre-allocated collections
7. **Use compiled queries** for frequently executed EF Core queries

For the complete performance pattern catalog with ~50 anti-patterns across async, memory, strings, collections, LINQ, regex, serialization, and I/O, see [references/performance-patterns.md](references/performance-patterns.md).

## .NET AI integration

When integrating AI/ML features into .NET applications:

### Technology selection decision tree

| Task type                                    | Technology                | Package                                        |
| -------------------------------------------- | ------------------------- | ---------------------------------------------- |
| Structured data (classification, regression) | ML.NET                    | `Microsoft.ML`                                 |
| LLM chat (single prompt/response)            | Microsoft.Extensions.AI   | `Microsoft.Extensions.AI`                      |
| Agentic workflows (tool calling, multi-step) | Microsoft Agent Framework | `Microsoft.Agents.AI`                          |
| Custom model inference                       | ONNX Runtime              | `Microsoft.ML.OnnxRuntime`                     |
| Local/offline LLM                            | OllamaSharp               | `OllamaSharp`                                  |
| Vector search / RAG                          | MEVD                      | `Microsoft.Extensions.VectorData.Abstractions` |

**Critical rule:** Never use an LLM for tasks ML.NET handles well. LLMs are slower, more expensive, and non-deterministic for structured data tasks.

### Guardrails

- Always register AI services via DI — never instantiate clients directly
- Set temperature explicitly (use `0` for deterministic tasks)
- Always implement retry with exponential backoff
- Cap agentic loops with `MaximumIterations`
- Pin model versions (e.g., `gpt-4o-2024-08-06`)
- Never hardcode API keys — use Key Vault, user-secrets, or env vars

## Reference documents

The `references/` folder contains **task-workflow guides** with step-by-step procedures. Each follows the format: When to Use → Inputs → Workflow → Validation → Pitfalls. Load the relevant guide when the task matches:

| Reference file                                                               | Task workflow                                | When to load                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| [references/aspnet-patterns.md](references/aspnet-patterns.md)               | Middleware & error handling patterns         | Setting up middleware pipeline or ProblemDetails      |
| [references/ef-core-optimization.md](references/ef-core-optimization.md)     | 8-step EF Core query optimization            | Slow queries, N+1 detection, tracking modes, bulk ops |
| [references/performance-patterns.md](references/performance-patterns.md)     | Performance anti-pattern scan (~50 patterns) | Performance review, optimization pass, code audit     |
| [references/msbuild-best-practices.md](references/msbuild-best-practices.md) | MSBuild audit (AP-01 through AP-15)          | Build issues, project modernization, legacy migration |
| [references/testing-patterns.md](references/testing-patterns.md)             | Test runner & testing patterns               | Running tests, writing tests, diagnosing failures     |
| [references/convert-to-cpm.md](references/convert-to-cpm.md)                 | 9-step CPM migration                         | Multi-project version consolidation                   |
| [references/ai-integration.md](references/ai-integration.md)                 | AI/ML technology selection & integration     | Adding AI features to .NET apps                       |

## Validation checklist

Before delivering any .NET implementation:

- [ ] Solution follows Clean Architecture layer separation
- [ ] All classes are `sealed` unless designed for inheritance
- [ ] Async methods accept and pass `CancellationToken`
- [ ] EF Core queries use `AsNoTracking()` for reads
- [ ] No N+1 query patterns (verified via SQL logging)
- [ ] DI lifetimes are correct (no captive dependencies)
- [ ] Error handling uses ProblemDetails
- [ ] Unit tests follow Arrange-Act-Assert with descriptive names
- [ ] Central Package Management is configured for multi-project solutions
- [ ] `Directory.Build.props` centralizes shared properties
- [ ] No hardcoded connection strings or secrets in source

## Common pitfalls

| Pitfall                                      | Solution                                                         |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Injecting scoped into singleton              | Use `IServiceScopeFactory` or change lifetime                    |
| `async void` methods                         | Always return `Task` or `ValueTask` (except event handlers)      |
| `.Result` or `.Wait()` on tasks              | Use `await` all the way — blocking causes deadlocks              |
| `ToList()` before `Where()`                  | Filter first, materialize last                                   |
| Missing `CancellationToken`                  | Pass through every async method signature                        |
| `Count() > 0` for existence                  | Use `Any()` — stops at first match                               |
| Global `DbContext` singleton                 | DbContext must be scoped (per-request)                           |
| `new HttpClient()` per request               | Use `IHttpClientFactory` or typed clients                        |
| Unsealed classes everywhere                  | Seal by default for performance and design clarity               |
| String comparison without `StringComparison` | Always specify `StringComparison.Ordinal` or `OrdinalIgnoreCase` |
