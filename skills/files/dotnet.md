# .NET / C# Testing Reference

## Frameworks: xUnit (preferred), NUnit, MSTest

### Setup (xUnit)

```bash
dotnet new xunit -n MyApp.Tests
dotnet add MyApp.Tests package Moq
dotnet add MyApp.Tests package FluentAssertions
dotnet add MyApp.Tests package Microsoft.AspNetCore.Mvc.Testing
```

```xml
<!-- MyApp.Tests.csproj -->
<PackageReference Include="xunit" Version="2.*" />
<PackageReference Include="xunit.runner.visualstudio" Version="2.*" />
<PackageReference Include="Moq" Version="4.*" />
<PackageReference Include="FluentAssertions" Version="7.*" />
<PackageReference Include="coverlet.collector" Version="6.*" />
```

## Unit Tests

### Basic xUnit

```csharp
public class DiscountCalculatorTests
{
    private readonly DiscountCalculator _calculator = new();

    [Fact]
    public void Calculate_WithValidDiscount_ReturnsDiscountedPrice()
    {
        var result = _calculator.Calculate(price: 100m, discountPct: 10);
        result.Should().Be(90m);
    }

    [Fact]
    public void Calculate_WithNegativePrice_ThrowsArgumentException()
    {
        var act = () => _calculator.Calculate(price: -10m, discountPct: 5);
        act.Should().Throw<ArgumentException>()
           .WithMessage("*non-negative*");
    }

    [Theory]
    [InlineData(100, 0, 100)]
    [InlineData(100, 50, 50)]
    [InlineData(100, 100, 0)]
    [InlineData(0, 50, 0)]
    public void Calculate_BoundaryValues(decimal price, int pct, decimal expected)
    {
        _calculator.Calculate(price, pct).Should().Be(expected);
    }
}
```

### Mocking with Moq

```csharp
public class OrderServiceTests
{
    private readonly Mock<IEmailSender> _emailMock = new();
    private readonly Mock<IOrderRepository> _repoMock = new();
    private readonly OrderService _service;

    public OrderServiceTests()
    {
        _service = new OrderService(_repoMock.Object, _emailMock.Object);
    }

    [Fact]
    public async Task PlaceOrder_SendsConfirmationEmail()
    {
        _repoMock.Setup(r => r.SaveAsync(It.IsAny<Order>()))
                 .ReturnsAsync(new Order { Id = 1 });

        await _service.PlaceOrderAsync(new OrderRequest { Item = "Widget" });

        _emailMock.Verify(
            e => e.SendAsync(It.Is<string>(to => to.Contains("@")),
                             It.Is<string>(body => body.Contains("Widget"))),
            Times.Once);
    }

    [Fact]
    public async Task PlaceOrder_WhenRepoFails_ThrowsServiceException()
    {
        _repoMock.Setup(r => r.SaveAsync(It.IsAny<Order>()))
                 .ThrowsAsync(new DbException("Connection lost"));

        var act = () => _service.PlaceOrderAsync(new OrderRequest { Item = "Widget" });

        await act.Should().ThrowAsync<ServiceException>()
                 .WithMessage("*failed to place*");
    }
}
```

## Integration Tests: ASP.NET Core (WebApplicationFactory)

```csharp
public class ItemsApiTests : IClassFixture<WebApplicationFactory<Program>>
{
    private readonly HttpClient _client;

    public ItemsApiTests(WebApplicationFactory<Program> factory)
    {
        _client = factory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureServices(services =>
            {
                // Replace real DB with in-memory
                services.RemoveAll<DbContextOptions<AppDbContext>>();
                services.AddDbContext<AppDbContext>(opts =>
                    opts.UseInMemoryDatabase("TestDb"));
            });
        }).CreateClient();
    }

    [Fact]
    public async Task PostItem_Returns201()
    {
        var response = await _client.PostAsJsonAsync("/api/items",
            new { Name = "Widget", Price = 9.99 });

        response.StatusCode.Should().Be(HttpStatusCode.Created);
        var item = await response.Content.ReadFromJsonAsync<ItemDto>();
        item!.Name.Should().Be("Widget");
    }

    [Fact]
    public async Task GetMissingItem_Returns404()
    {
        var response = await _client.GetAsync("/api/items/99999");
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }
}
```

## EF Core Testing

```csharp
public class UserRepositoryTests : IDisposable
{
    private readonly AppDbContext _context;
    private readonly UserRepository _repo;

    public UserRepositoryTests()
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        _context = new AppDbContext(options);
        _repo = new UserRepository(_context);
    }

    [Fact]
    public async Task GetByEmail_ReturnsMatchingUser()
    {
        _context.Users.Add(new User { Name = "Alice", Email = "alice@test.com" });
        await _context.SaveChangesAsync();

        var user = await _repo.GetByEmailAsync("alice@test.com");

        user.Should().NotBeNull();
        user!.Name.Should().Be("Alice");
    }

    public void Dispose() => _context.Dispose();
}
```

## NUnit Equivalent

```csharp
[TestFixture]
public class CalculatorTests
{
    [Test]
    public void Add_ReturnsSumOfArguments()
    {
        Assert.That(Calculator.Add(2, 3), Is.EqualTo(5));
    }

    [TestCase(1, 1, 2)]
    [TestCase(0, 0, 0)]
    public void Add_Parameterized(int a, int b, int expected)
    {
        Assert.That(Calculator.Add(a, b), Is.EqualTo(expected));
    }
}
```

## Running

```bash
dotnet test                                   # all
dotnet test --filter "Category=Unit"          # by trait
dotnet test --collect:"XPlat Code Coverage"   # with coverage
dotnet test --no-build                        # skip build
```

## Key Principles for .NET Tests

1. **Use `IClassFixture<T>`** for shared expensive setup (WebApplicationFactory, DB).
2. **Prefer FluentAssertions** — `result.Should().Be(x)` reads better than `Assert.Equal`.
3. **Use `WebApplicationFactory`** for integration — don't start Kestrel manually.
4. **Use `InMemoryDatabase` or `Testcontainers`** — never test against production DB.
5. **Implement `IDisposable`** on test classes that create resources.
