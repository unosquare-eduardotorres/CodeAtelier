# React Testing Reference

Use alongside `references/javascript-typescript.md` for base Vitest/Jest patterns.

## Setup
```bash
npm install -D @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
```

```typescript
// vitest.config.ts — add jsdom environment
test: {
  environment: 'jsdom',
  setupFiles: ['./src/test-setup.ts'],
}
```

```typescript
// src/test-setup.ts
import '@testing-library/jest-dom'
```

## Component Tests

### Basic Render
```typescript
import { render, screen } from '@testing-library/react'
import { Greeting } from './Greeting'

it('renders the greeting message', () => {
  render(<Greeting name="Alice" />)
  expect(screen.getByText('Hello, Alice!')).toBeInTheDocument()
})
```

### User Interactions
```typescript
import userEvent from '@testing-library/user-event'

it('increments count on click', async () => {
  const user = userEvent.setup()
  render(<Counter />)

  await user.click(screen.getByRole('button', { name: /increment/i }))

  expect(screen.getByText('Count: 1')).toBeInTheDocument()
})
```

### Forms
```typescript
it('submits form with entered data', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(<LoginForm onSubmit={onSubmit} />)

  await user.type(screen.getByLabelText('Email'), 'alice@test.com')
  await user.type(screen.getByLabelText('Password'), 'secret123')
  await user.click(screen.getByRole('button', { name: /sign in/i }))

  expect(onSubmit).toHaveBeenCalledWith({
    email: 'alice@test.com',
    password: 'secret123',
  })
})
```

### Async / Loading States
```typescript
it('shows data after loading', async () => {
  render(<UserProfile userId={1} />)

  // Verify loading state
  expect(screen.getByText('Loading...')).toBeInTheDocument()

  // Wait for data
  expect(await screen.findByText('Alice')).toBeInTheDocument()
  expect(screen.queryByText('Loading...')).not.toBeInTheDocument()
})
```

### Custom Hooks
```typescript
import { renderHook, act } from '@testing-library/react'
import { useCounter } from './useCounter'

it('increments and resets', () => {
  const { result } = renderHook(() => useCounter(0))

  act(() => result.current.increment())
  expect(result.current.count).toBe(1)

  act(() => result.current.reset())
  expect(result.current.count).toBe(0)
})
```

### Context Providers
```typescript
function renderWithProviders(ui: React.ReactElement) {
  return render(
    <ThemeProvider theme="light">
      <AuthProvider user={mockUser}>
        {ui}
      </AuthProvider>
    </ThemeProvider>
  )
}

it('shows user name from context', () => {
  renderWithProviders(<Navbar />)
  expect(screen.getByText('Alice')).toBeInTheDocument()
})
```

### Mocking API Calls (MSW)
```typescript
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

const server = setupServer(
  http.get('/api/user/1', () =>
    HttpResponse.json({ id: 1, name: 'Alice' })
  ),
)

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('fetches and displays user', async () => {
  render(<UserProfile userId={1} />)
  expect(await screen.findByText('Alice')).toBeInTheDocument()
})
```

## Key Principles for React Tests

1. **Query by accessibility role first** — `getByRole`, `getByLabelText`, `getByText`.
   Use `data-testid` only as last resort.
2. **Use `userEvent` over `fireEvent`** — it simulates real user behavior (focus, type, tab).
3. **Test behavior, not state** — don't assert on `useState` internals. Assert on
   what the user sees.
4. **Avoid testing implementation** — don't assert on component instance methods or
   internal state. If you refactor from class to hooks, tests shouldn't break.
5. **Mock at the network boundary** — use MSW to intercept fetch/axios. Don't mock
   your own hooks or services unless absolutely necessary.
