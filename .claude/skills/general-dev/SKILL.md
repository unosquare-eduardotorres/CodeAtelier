---
name: general-dev
description: >
  General software development patterns, best practices, and cross-language conventions.
  Use for Node.js, Python, Go, Rust, API design, Docker, testing strategies, and any
  development work not covered by specialized skills. Covers: backend development,
  scripting, CLI tools, API design, containerization, testing, security, performance.
user-invocable: false
---

# General Software Development Patterns

> **Version**: 1.0
> **Last updated**: 2026-03-23
> **Scope**: Cross-language backend, scripting, API, infrastructure

## Before you start

1. Identify the language/runtime: check `package.json`, `go.mod`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, or `Makefile`
2. Check existing code style: look for `.editorconfig`, linter configs (`.eslintrc`, `ruff.toml`, `.golangci.yml`)
3. Check test patterns: look for `__tests__/`, `*_test.go`, `test_*.py`, `*.spec.ts`
4. Check CI/CD: `.github/workflows/`, `Dockerfile`, `docker-compose.yml`
5. Match the project's conventions — don't impose your own

## Node.js / TypeScript patterns

### Project structure (backend)
```
src/
├── index.ts          # Entry point
├── routes/           # HTTP route handlers
├── services/         # Business logic
├── repositories/     # Data access
├── middleware/        # Express/Fastify middleware
├── utils/            # Shared utilities
├── types/            # TypeScript type definitions
└── config/           # Environment config
```

### Error handling
```typescript
// Custom error classes for different domains
class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR'
  ) {
    super(message)
    this.name = 'AppError'
  }
}

// Always use try-catch with typed errors
try {
  const result = await riskyOperation()
} catch (error) {
  if (error instanceof AppError) {
    // Handle known errors
  } else {
    // Wrap unknown errors
    throw new AppError('Unexpected error', 500, 'UNKNOWN')
  }
}
```

### Async patterns
```typescript
// Prefer Promise.allSettled for parallel independent operations
const results = await Promise.allSettled([
  fetchUser(id),
  fetchPermissions(id),
  fetchPreferences(id)
])

// Use AbortController for cancellable operations
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 5000)
try {
  const response = await fetch(url, { signal: controller.signal })
} finally {
  clearTimeout(timeout)
}
```

## API design principles

### REST conventions
- Use nouns for resources: `/users`, `/orders/{id}/items`
- Use HTTP verbs correctly: GET (read), POST (create), PUT (replace), PATCH (update), DELETE
- Return appropriate status codes: 200, 201, 204, 400, 401, 403, 404, 409, 422, 500
- Always validate request bodies and query params
- Use pagination for list endpoints: `?page=1&limit=20`
- Version APIs: `/api/v1/`

### Input validation
```typescript
// Always validate at the boundary
function validateCreateUser(input: unknown): CreateUserDto {
  if (!input || typeof input !== 'object') throw new AppError('Invalid input', 400)
  const { name, email } = input as Record<string, unknown>
  if (typeof name !== 'string' || name.length < 1) throw new AppError('Name required', 400)
  if (typeof email !== 'string' || !email.includes('@')) throw new AppError('Valid email required', 400)
  return { name: name.trim(), email: email.toLowerCase().trim() }
}
```

## Docker patterns

### Multi-stage build (Node.js)
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --production=false
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

## Testing strategy

| Level | What | Tools | Coverage target |
|-------|------|-------|-----------------|
| Unit | Pure functions, utilities | Jest/Vitest, pytest, Go testing | 80%+ |
| Integration | API endpoints, DB queries | Supertest, httptest | Key paths |
| E2E | User workflows | Playwright, Cypress | Critical flows |

### Test structure (Arrange-Act-Assert)
```typescript
describe('UserService', () => {
  it('should create a user with valid input', async () => {
    // Arrange
    const input = { name: 'Alice', email: 'alice@example.com' }

    // Act
    const user = await userService.create(input)

    // Assert
    expect(user.id).toBeDefined()
    expect(user.name).toBe('Alice')
    expect(user.email).toBe('alice@example.com')
  })
})
```

## Security checklist

- [ ] Validate all inputs at API boundary
- [ ] Use parameterized queries (never string concatenation for SQL)
- [ ] Hash passwords with bcrypt/argon2 (never MD5/SHA)
- [ ] Use HTTPS in production
- [ ] Set security headers (Helmet.js for Express)
- [ ] Implement rate limiting on auth endpoints
- [ ] Never log sensitive data (passwords, tokens, PII)
- [ ] Use environment variables for secrets (never hardcode)
- [ ] Set appropriate CORS policies
- [ ] Keep dependencies updated (`npm audit`, `pip-audit`)

## Performance patterns

- Use connection pooling for databases
- Cache expensive computations (Redis, in-memory LRU)
- Stream large files instead of buffering in memory
- Use worker threads / child processes for CPU-intensive work
- Profile before optimizing — measure, don't guess
- Set appropriate timeouts on all external calls
