# Node.js Testing Reference

Covers Express, NestJS, Fastify, and general Node.js server testing.
Use alongside `references/javascript-typescript.md` for base Vitest/Jest patterns.

## Express Integration Tests (supertest)

```bash
npm install -D supertest @types/supertest
```

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from './app'
import { setupTestDb, teardownTestDb } from './test-helpers'

describe('[integration] /api/items', () => {
  let app: Express.Application

  beforeAll(async () => {
    await setupTestDb()
    app = createApp({ database: 'test' })
  })

  afterAll(async () => {
    await teardownTestDb()
  })

  it('POST creates item and returns 201', async () => {
    const res = await request(app)
      .post('/api/items')
      .send({ name: 'Widget', price: 9.99 })
      .expect(201)

    expect(res.body).toMatchObject({ name: 'Widget', price: 9.99 })
    expect(res.body.id).toBeDefined()
  })

  it('GET returns 404 for missing item', async () => {
    await request(app).get('/api/items/99999').expect(404)
  })

  it('requires auth for protected routes', async () => {
    await request(app).delete('/api/items/1').expect(401)
  })
})
```

## NestJS Testing

```typescript
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from './app.module'

describe('[integration] AppController', () => {
  let app: INestApplication

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(DatabaseService)
      .useValue(mockDbService)
      .compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET /health returns 200', () => {
    return request(app.getHttpServer()).get('/health').expect(200)
  })
})
```

### NestJS Service Unit Test

```typescript
import { Test } from '@nestjs/testing'
import { UserService } from './user.service'
import { UserRepository } from './user.repository'

describe('[unit] UserService', () => {
  let service: UserService
  let repo: { findOne: ReturnType<typeof vi.fn> }

  beforeEach(async () => {
    repo = { findOne: vi.fn() }
    const module = await Test.createTestingModule({
      providers: [UserService, { provide: UserRepository, useValue: repo }]
    }).compile()

    service = module.get(UserService)
  })

  it('returns user by id', async () => {
    repo.findOne.mockResolvedValue({ id: 1, name: 'Alice' })
    const user = await service.findById(1)
    expect(user.name).toBe('Alice')
  })
})
```

## Fastify Testing

```typescript
import Fastify from 'fastify'
import { appPlugin } from './app'

describe('[integration] Fastify routes', () => {
  const app = Fastify()

  beforeAll(async () => {
    await app.register(appPlugin)
    await app.ready()
  })

  afterAll(() => app.close())

  it('GET /api/status returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/status' })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toMatchObject({ status: 'ok' })
  })
})
```

## Middleware Testing

```typescript
import { authMiddleware } from './auth'
import { vi } from 'vitest'

describe('[unit] authMiddleware', () => {
  const next = vi.fn()

  it('calls next() with valid token', () => {
    const req = { headers: { authorization: 'Bearer valid-token' } } as any
    const res = {} as any
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalledWith()
  })

  it('returns 401 without token', () => {
    const req = { headers: {} } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
  })
})
```

## Database Integration (Prisma example)

```typescript
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

beforeEach(async () => {
  // Clean tables in dependency order
  await prisma.order.deleteMany()
  await prisma.user.deleteMany()
})

afterAll(() => prisma.$disconnect())

it('creates user and retrieves by email', async () => {
  await prisma.user.create({ data: { name: 'Alice', email: 'a@b.com' } })
  const user = await prisma.user.findUnique({ where: { email: 'a@b.com' } })
  expect(user?.name).toBe('Alice')
})
```

## Key Principles for Node Tests

1. **Use `supertest` or `inject()`** — don't start a real HTTP server for integration tests.
2. **Isolate test data** — clean DB before each test, not after (so you can inspect on failure).
3. **Mock external services, not your own** — mock Stripe, SendGrid; test your own DB layer for real.
4. **Test middleware in isolation** — mock `req`, `res`, `next` for unit tests.
5. **Test error handling** — verify that errors return correct status codes and messages.
