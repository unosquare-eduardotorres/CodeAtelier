# JavaScript / TypeScript Testing Reference

## Framework: Vitest (preferred) or Jest

### Vitest Setup

```bash
npm install -D vitest @vitest/coverage-v8
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // or 'jsdom' for browser-like
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] }
  }
})
```

### Unit Tests

```typescript
import { describe, it, expect } from 'vitest'
import { calculateDiscount } from './math'

describe('[unit] calculateDiscount', () => {
  it('applies percentage discount', () => {
    expect(calculateDiscount(100, 10)).toBe(90)
  })

  it('throws on negative price', () => {
    expect(() => calculateDiscount(-10, 5)).toThrow('Price must be non-negative')
  })

  it.each([
    [100, 0, 100],
    [100, 50, 50],
    [100, 100, 0],
    [0, 50, 0]
  ])('discount(%d, %d) = %d', (price, pct, expected) => {
    expect(calculateDiscount(price, pct)).toBe(expected)
  })
})
```

### Mocking

```typescript
import { vi, describe, it, expect } from 'vitest'
import { sendNotification } from './notifications'
import * as emailClient from './emailClient'

it('calls email service', async () => {
  const spy = vi.spyOn(emailClient, 'send').mockResolvedValue(undefined)
  await sendNotification(42, 'Hello')
  expect(spy).toHaveBeenCalledWith({ to: 'user42@example.com', body: 'Hello' })
})
```

### Module Mocking

```typescript
vi.mock('./database', () => ({
  getUser: vi.fn().mockResolvedValue({ id: 1, name: 'Alice' })
}))

// Mock fetch globally
global.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ data: 'test' })
})
```

### Snapshot Testing

```typescript
it('serializes config correctly', () => {
  const config = buildConfig({ env: 'test' })
  expect(config).toMatchSnapshot()
})
```

Use sparingly. Good for render output and API shapes. Bad for business logic.

### Running

```bash
npx vitest run                    # all
npx vitest                        # watch mode
npx vitest run --coverage         # with coverage
npx vitest run -t "calculateDiscount"  # filter by name
```

### Jest Equivalents

```typescript
// jest.fn() instead of vi.fn()
// jest.spyOn() instead of vi.spyOn()
// jest.mock() instead of vi.mock()
// Config: jest.config.ts instead of vitest.config.ts
```
