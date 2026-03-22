# .NET Testing Patterns

Step-by-step workflow for running tests, writing tests, and applying modern testing patterns in .NET projects.

## When to use

- Running tests or diagnosing test failures
- Writing new unit or integration tests
- Setting up a test project from scratch
- Reviewing test quality or coverage

## When NOT to use

- Integration/load testing infrastructure (suggest k6, NBomber, or JMeter)
- Non-.NET test frameworks
- UI/E2E testing (suggest Playwright)

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Solution/project path | Yes | Where to run/write tests |
| Filter expression | No | Class/method name filter |
| Test framework | No | Auto-detected if not specified |

## Workflow

### Step 1: Detect test platform

```bash
# Check global.json for MSTest.Sdk
grep -r 'MSTest.Sdk' global.json 2>/dev/null

# Check .csproj files for framework
grep -rn 'xunit\|MSTest.TestFramework\|NUnit' --include='*.csproj' .
```

### Step 2: Build the solution

```bash
dotnet build
```

Fix any compilation errors before running tests.

### Step 3: Run tests

```bash
# Run all tests
dotnet test

# Run with filter
dotnet test --filter "FullyQualifiedName~OrderService"

# Run specific project
dotnet test tests/MyApp.Application.Tests/

# Run with coverage
dotnet test --collect "Code Coverage"

# Run with blame mode (detect hanging tests)
dotnet test --blame --blame-hang-timeout 5min

# Verbose output
dotnet test -v detailed
```

### Step 4: If failures, analyze and fix

Review output for assertion failures, timeout errors, or infrastructure issues.

### Step 5: If writing new tests, apply patterns below

## Test project setup

### xUnit (recommended for most projects)

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" />
    <PackageReference Include="xunit" />
    <PackageReference Include="xunit.runner.visualstudio" />
    <PackageReference Include="Moq" />
    <PackageReference Include="FluentAssertions" />
  </ItemGroup>
</Project>
```

### MSTest (MSTest.Sdk — simplest setup)

```xml
<Project Sdk="MSTest.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
```

Put the MSTest.Sdk version in `global.json`:

```json
{
  "msbuild-sdks": {
    "MSTest.Sdk": "3.8.2"
  }
}
```

## Test naming and structure

### Naming convention

`MethodName_Scenario_ExpectedBehavior`

```csharp
[Fact]
public async Task CreateOrder_WithValidInput_ReturnsOrderId() { }

[Fact]
public async Task CreateOrder_WithNegativeQuantity_ThrowsValidationException() { }

[Fact]
public async Task GetOrder_WhenNotFound_ReturnsNull() { }
```

### Arrange-Act-Assert pattern

```csharp
[Fact]
public async Task CalculateTotal_WithDiscount_ReturnsReducedPrice()
{
    // Arrange
    var service = new PriceCalculator();
    var order = new Order { Price = 100m, DiscountPercent = 10 };

    // Act
    var total = service.CalculateTotal(order);

    // Assert
    Assert.Equal(90m, total);
}
```

### Seal test classes

Always seal test classes for performance and design clarity:

```csharp
// xUnit
public sealed class OrderServiceTests { }

// MSTest
[TestClass]
public sealed class OrderServiceTests { }
```

## Data-driven tests

### xUnit Theory with InlineData

```csharp
[Theory]
[InlineData(100, 10, 90)]
[InlineData(200, 25, 150)]
[InlineData(50, 0, 50)]
public void ApplyDiscount_ReturnsExpectedPrice(decimal price, int percent, decimal expected)
{
    var result = PriceCalculator.ApplyDiscount(price, percent);
    Assert.Equal(expected, result);
}
```

### xUnit Theory with MemberData

```csharp
[Theory]
[MemberData(nameof(InvalidInputs))]
public async Task CreateOrder_WithInvalidInput_ThrowsValidationException(CreateOrderCommand command)
{
    await Assert.ThrowsAsync<ValidationException>(
        () => _sut.CreateOrderAsync(command, CancellationToken.None));
}

public static TheoryData<CreateOrderCommand> InvalidInputs => new()
{
    new CreateOrderCommand("", 1),     // Empty name
    new CreateOrderCommand("Test", 0), // Zero quantity
    new CreateOrderCommand("Test", -1) // Negative quantity
};
```

### MSTest DataRow and DynamicData

```csharp
[TestMethod]
[DataRow(1, 2, 3)]
[DataRow(0, 0, 0, DisplayName = "Zeros")]
[DataRow(-1, 1, 0)]
public void Add_ReturnsExpectedSum(int a, int b, int expected)
{
    Assert.AreEqual(expected, Calculator.Add(a, b));
}

// ValueTuple DynamicData (MSTest 3.7+)
[TestMethod]
[DynamicData(nameof(DiscountData))]
public void ApplyDiscount_ReturnsExpectedPrice(decimal price, int percent, decimal expected)
{
    Assert.AreEqual(expected, PriceCalculator.ApplyDiscount(price, percent));
}

public static IEnumerable<(decimal price, int percent, decimal expected)> DiscountData =>
[
    (100m, 10, 90m),
    (200m, 25, 150m),
];
```

## Exception testing

### xUnit

```csharp
[Fact]
public async Task CreateOrder_WithNull_ThrowsArgumentNullException()
{
    var ex = await Assert.ThrowsAsync<ArgumentNullException>(
        () => _sut.CreateOrderAsync(null!, CancellationToken.None));

    Assert.Equal("command", ex.ParamName);
}
```

### MSTest (modern — no [ExpectedException])

```csharp
// Synchronous
var ex = Assert.ThrowsExactly<ArgumentNullException>(() => service.Process(null));
Assert.AreEqual("input", ex.ParamName);

// Async
var ex = await Assert.ThrowsExactlyAsync<InvalidOperationException>(
    async () => await service.ProcessAsync(null));
```

## Mocking patterns

### Repository mocking with Moq

```csharp
public sealed class OrderServiceTests
{
    private readonly Mock<IOrderRepository> _repoMock = new();
    private readonly Mock<ILogger<OrderService>> _loggerMock = new();
    private readonly OrderService _sut;

    public OrderServiceTests()
    {
        _sut = new OrderService(_repoMock.Object, _loggerMock.Object);
    }

    [Fact]
    public async Task GetById_WhenExists_ReturnsOrder()
    {
        // Arrange
        var expected = new Order { Id = 1, Total = 99.99m };
        _repoMock
            .Setup(r => r.GetByIdAsync(1, It.IsAny<CancellationToken>()))
            .ReturnsAsync(expected);

        // Act
        var result = await _sut.GetByIdAsync(1, CancellationToken.None);

        // Assert
        Assert.NotNull(result);
        Assert.Equal(99.99m, result.Total);
    }
}
```

### HttpClient mocking

```csharp
public sealed class ExternalApiTests
{
    [Fact]
    public async Task GetData_ReturnsDeserializedResponse()
    {
        // Arrange
        var handler = new MockHttpMessageHandler("""{"id": 1, "name": "Test"}""");
        var client = new HttpClient(handler) { BaseAddress = new Uri("https://api.test.com") };
        var sut = new ExternalApiClient(client);

        // Act
        var result = await sut.GetDataAsync(1, CancellationToken.None);

        // Assert
        Assert.Equal("Test", result.Name);
    }
}

internal sealed class MockHttpMessageHandler(string response) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken ct)
    {
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(response, Encoding.UTF8, "application/json")
        });
    }
}
```

## Integration testing with WebApplicationFactory

```csharp
public sealed class OrdersApiTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client = factory.WithWebHostBuilder(builder =>
    {
        builder.ConfigureServices(services =>
        {
            // Replace real DbContext with in-memory
            services.RemoveAll<DbContextOptions<AppDbContext>>();
            services.AddDbContext<AppDbContext>(options =>
                options.UseInMemoryDatabase("TestDb"));
        });
    }).CreateClient();

    [Fact]
    public async Task GetOrders_ReturnsOk()
    {
        var response = await _client.GetAsync("/api/orders");
        response.EnsureSuccessStatusCode();

        var orders = await response.Content.ReadFromJsonAsync<List<OrderDto>>();
        Assert.NotNull(orders);
    }

    [Fact]
    public async Task CreateOrder_WithValidPayload_ReturnsCreated()
    {
        var payload = new { Name = "Test Order", Quantity = 2 };
        var response = await _client.PostAsJsonAsync("/api/orders", payload);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }
}
```

## Validation checklist

- [ ] All tests pass (`dotnet test` exits 0)
- [ ] No warnings about test discovery
- [ ] Test names follow `MethodName_Scenario_ExpectedBehavior`
- [ ] Test classes are sealed
- [ ] AAA pattern used consistently
- [ ] No shared mutable state between tests
- [ ] Exception tests use `Assert.Throws`/`Assert.ThrowsExactly`, not `[ExpectedException]`

## Anti-patterns to avoid

| Anti-pattern | Solution |
|-------------|----------|
| `Assert.AreEqual(actual, expected)` — swapped args | Always: `Assert.AreEqual(expected, actual)` |
| `[ExpectedException]` in MSTest | Use `Assert.ThrowsExactly<T>` |
| `items.Single()` — unclear failure message | Use `Assert.Single(items)` (xUnit) or `Assert.ContainsSingle(items)` (MSTest) |
| Hard cast `(MyType)result` | Use `Assert.IsType<MyType>(result)` |
| Testing implementation details (private methods) | Test through public API surface |
| Shared mutable state between tests | Each test creates its own instances |
| `Thread.Sleep` in tests | Use `Task.Delay` with `CancellationToken` or mock time |
| No `CancellationToken` in async tests | Use `TestContext.CancellationToken` (MSTest) or `CancellationTokenSource` |
| Non-sealed test classes | Seal by default for performance |
| Excessive mocking (mocking everything) | Only mock external dependencies, not the SUT |
