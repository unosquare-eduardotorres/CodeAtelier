# ASP.NET Core Middleware and Error Handling Patterns

## Middleware pipeline (correct order)

```csharp
var app = builder.Build();

// 1. Exception handling (outermost)
app.UseExceptionHandler("/error");

// 2. HSTS & HTTPS redirection
if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}
app.UseHttpsRedirection();

// 3. Static files (before routing)
app.UseStaticFiles();

// 4. Routing
app.UseRouting();

// 5. CORS (after routing, before auth)
app.UseCors();

// 6. Authentication & Authorization
app.UseAuthentication();
app.UseAuthorization();

// 7. Custom middleware
app.UseRequestLogging();

// 8. Endpoints
app.MapControllers();
app.MapOrderEndpoints();
```

**Order matters.** Exception handling must be outermost to catch all errors. Authentication before authorization. Routing before CORS and auth. Endpoints last.

## Global error handling with ProblemDetails

```csharp
// Use ProblemDetails for consistent error responses
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
    };
});

// Custom exception handler middleware
app.UseExceptionHandler(appBuilder =>
{
    appBuilder.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        var problemDetails = exception switch
        {
            NotFoundException => new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "Resource not found",
                Detail = exception.Message
            },
            ValidationException ve => new ProblemDetails
            {
                Status = StatusCodes.Status400BadRequest,
                Title = "Validation failed",
                Extensions = { ["errors"] = ve.Errors }
            },
            _ => new ProblemDetails
            {
                Status = StatusCodes.Status500InternalServerError,
                Title = "An unexpected error occurred"
            }
        };

        context.Response.StatusCode = problemDetails.Status ?? 500;
        await context.Response.WriteAsJsonAsync(problemDetails);
    });
});
```

## ProblemDetails response format

All errors should return RFC 7807 ProblemDetails:

```json
{
  "type": "https://tools.ietf.org/html/rfc7807",
  "title": "Validation failed",
  "status": 400,
  "detail": "One or more validation errors occurred.",
  "traceId": "00-abc123-def456-01",
  "errors": {
    "Name": ["Name is required"],
    "Quantity": ["Quantity must be greater than 0"]
  }
}
```
