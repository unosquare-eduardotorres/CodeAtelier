# Testing Patterns Reference

Cross-cutting patterns that apply regardless of language or framework.

## The Testing Pyramid

```
        /  E2E  \          Few — slow, expensive, high confidence
       /----------\
      / Integration \      Some — moderate speed, real dependencies
     /----------------\
    /    Unit Tests     \   Many — fast, isolated, cheap
   /____________________\
```

Guideline: ~70% unit, ~20% integration, ~10% E2E. Adjust for project shape —
data-heavy backends lean integration; simple CRUD apps skip trivial unit tests.

## Test Doubles

| Double   | What it does                        | When to use                          |
|----------|-------------------------------------|--------------------------------------|
| Stub     | Returns canned data                 | Isolate from slow/unreliable deps    |
| Mock     | Records calls for verification      | Verify interactions (email sent?)    |
| Spy      | Wraps real impl, records calls      | Observe without replacing behavior   |
| Fake     | Simplified working implementation   | In-memory DB, local file system      |
| Fixture  | Pre-built test data                 | Consistent setup across tests        |

Prefer stubs for queries, mocks for commands. Don't mock what you don't own —
write integration tests against real external dependencies instead.

## Test Data Strategies

### Builder Pattern
```typescript
const user = buildUser({ email: 'specific@test.com' })
const order = buildOrder({ userId: user.id, status: 'cancelled' })
```

### Factory Pattern
```python
class UserFactory(factory.Factory):
    class Meta:
        model = User
    name = factory.Faker('name')
    email = factory.Faker('email')
```

### Fixture Files
For complex test data (large JSON, CSV), store in `fixtures/` alongside tests.

## Contract Testing

When services communicate, contract tests verify the interface:
- **Consumer-driven:** consumer writes expectations, provider verifies
- **Schema-based:** validate against OpenAPI/JSON Schema
- **Tools:** Pact (multi-language), Schemathesis (Python/OpenAPI)

## Snapshot Testing

Good for: component render output, API response shapes, error message formatting.
Bad for: business logic, anything that changes frequently by design.
Danger: developers blindly updating snapshots. Review every snapshot change.

## Testing Async Code

1. Always `await` the operation
2. Use framework async support (pytest-asyncio, Vitest native async)
3. Set reasonable timeouts
4. Test both success and failure paths

## Testing Error Handling

Every handled error path needs a test:
- Invalid input (wrong type, missing field, out of range)
- External failures (network timeout, DB connection lost)
- Authorization failures (missing token, insufficient permissions)
- Race conditions (concurrent modification, stale data)

Verify both the error type/status AND the error message/body.

## Performance Assertions

```python
def test_search_under_200ms(client, large_dataset):
    start = time.monotonic()
    response = client.get("/search?q=widget")
    elapsed = time.monotonic() - start
    assert response.status_code == 200
    assert elapsed < 0.2
```

Use sparingly — inherently flaky on variable-speed CI. Consider p99 over N runs.

## CI/CD Integration

```yaml
# GitHub Actions
test:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Unit tests
      run: npm test -- --coverage
    - name: Integration tests
      run: npm run test:integration
    - name: E2E tests
      run: npx playwright test
    - uses: codecov/codecov-action@v4
```

Run in order of speed: unit → integration → E2E. Fail fast on unit failures.
