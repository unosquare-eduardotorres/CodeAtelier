# E2E Testing Reference

## Framework: Playwright (preferred) or Cypress

### Playwright Setup
```bash
npm init playwright@latest
```

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
  webServer: {
    command: 'npm run dev',
    port: 3000,
    reuseExistingServer: !process.env.CI,
  },
})
```

## Page Object Model

```typescript
// e2e/pages/LoginPage.ts
import { type Page, type Locator } from '@playwright/test'

export class LoginPage {
  readonly emailInput: Locator
  readonly passwordInput: Locator
  readonly submitButton: Locator
  readonly errorMessage: Locator

  constructor(private page: Page) {
    this.emailInput = page.getByLabel('Email')
    this.passwordInput = page.getByLabel('Password')
    this.submitButton = page.getByRole('button', { name: 'Sign in' })
    this.errorMessage = page.getByRole('alert')
  }

  async goto() { await this.page.goto('/login') }

  async login(email: string, password: string) {
    await this.emailInput.fill(email)
    await this.passwordInput.fill(password)
    await this.submitButton.click()
  }
}
```

## Browser E2E Tests

```typescript
// e2e/auth.spec.ts
import { test, expect } from '@playwright/test'
import { LoginPage } from './pages/LoginPage'

test.describe('Authentication', () => {
  test('logs in with valid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.login('alice@example.com', 'password123')

    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByText('Welcome, Alice')).toBeVisible()
  })

  test('shows error for invalid credentials', async ({ page }) => {
    const loginPage = new LoginPage(page)
    await loginPage.goto()
    await loginPage.login('alice@example.com', 'wrong')

    await expect(loginPage.errorMessage).toContainText('Invalid credentials')
    await expect(page).toHaveURL('/login')
  })
})
```

## API-Level E2E (no browser)

```typescript
test.describe('Order API flow', () => {
  let token: string

  test.beforeAll(async ({ request }) => {
    const res = await request.post('/api/auth/login', {
      data: { email: 'test@example.com', password: 'test123' },
    })
    token = (await res.json()).token
  })

  test('create → get → cancel order', async ({ request }) => {
    const headers = { Authorization: `Bearer ${token}` }

    // Create
    const create = await request.post('/api/orders', {
      headers,
      data: { items: [{ sku: 'WIDGET-1', qty: 2 }] },
    })
    expect(create.status()).toBe(201)
    const { id } = await create.json()

    // Verify
    const get = await request.get(`/api/orders/${id}`, { headers })
    expect((await get.json()).status).toBe('pending')

    // Cancel
    const cancel = await request.post(`/api/orders/${id}/cancel`, { headers })
    expect(cancel.status()).toBe(200)
  })
})
```

## Auth State Reuse

Don't log in through the UI in every test:

```typescript
// e2e/global-setup.ts — run once, save auth state
import { chromium } from '@playwright/test'

export default async function globalSetup() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto('http://localhost:3000/login')
  await page.getByLabel('Email').fill('alice@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('/dashboard')
  await page.context().storageState({ path: 'e2e/.auth/user.json' })
  await browser.close()
}
```

```typescript
// Tests that need auth:
test.use({ storageState: 'e2e/.auth/user.json' })
```

## Cypress (when project uses it)

```typescript
// cypress/e2e/login.cy.ts
describe('Authentication', () => {
  it('logs in successfully', () => {
    cy.visit('/login')
    cy.get('[data-cy=email]').type('alice@example.com')
    cy.get('[data-cy=password]').type('password123')
    cy.get('[data-cy=submit]').click()
    cy.url().should('include', '/dashboard')
    cy.contains('Welcome, Alice')
  })
})
```

## Running
```bash
# Playwright
npx playwright test
npx playwright test --headed        # watch in browser
npx playwright test --ui            # interactive UI
npx playwright show-report          # HTML report

# Cypress
npx cypress run                     # headless
npx cypress open                    # interactive
```

## Key Principles
1. **Test journeys, not screens** — walk through realistic workflows end to end.
2. **Seed data via API** — don't click through forms to set up preconditions.
3. **Use accessible selectors** — `getByRole`, `getByLabel`, `data-testid`. Never CSS classes.
4. **Never `sleep()`** — use Playwright auto-waiting or explicit `waitFor`.
5. **Keep the suite lean** — 10-20 E2E tests. Each has maintenance cost.
6. **Save artifacts in CI** — screenshots, traces, videos on failure.
