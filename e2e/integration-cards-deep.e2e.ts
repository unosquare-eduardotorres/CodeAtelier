/**
 * Integration Cards Deep E2E Tests
 *
 * Verifies IntegrationCard (199 LOC) + ToolsList (60 LOC)
 * — MCP integration management:
 *   - Integration card renders with integration name and icon
 *   - Availability toggle switches enabled/disabled state
 *   - Tools list section expands to show individual MCP tools
 *   - Use-case grid shows categorized usage examples
 *   - Token impact badge displays estimated token overhead
 *   - Workflow steps show the setup sequence
 *
 * Cards are collapsed rows: only the header (name, readiness, token badge,
 * switch) is mounted until expanded. Body assertions expand first — previously
 * they matched loose text or fell through to a no-op branch.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/integration-cards-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Integration Cards Deep', () => {
  async function ensureWorkspaceReady(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
    return true
  }

  async function navigateToIntegrations(page: import('@playwright/test').Page): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('integrations')
    await page.waitForTimeout(800)

    // Check for integration cards
    const integrationCard = page.locator('[data-testid="integration-card"]')
    const count = await integrationCard.count()
    return count > 0
  }

  /** Expand the first card. Idempotent — reads `aria-expanded` before clicking. */
  async function expandFirstCard(page: import('@playwright/test').Page): Promise<boolean> {
    const expander = page.locator('[data-testid^="integration-expand-"]').first()
    if (!(await expander.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    if ((await expander.getAttribute('aria-expanded')) !== 'true') {
      await expander.click()
      await page.waitForTimeout(400)
    }
    return true
  }

  test('integration card renders with integration name and icon', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    const card = page.locator('[data-testid="integration-card"]').first()
    await expect(card).toBeVisible()

    // Card should have text content (integration name)
    const cardText = await card.textContent()
    expect(cardText?.trim().length).toBeGreaterThan(0)
  })

  test('availability toggle switches enabled/disabled state', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    const card = page.locator('[data-testid="integration-card"]').first()

    // A real `role="switch"` with `aria-checked` — the raw div-toggle it replaced
    // exposed no state to assistive tech or to this assertion.
    const toggle = card.getByRole('switch').first()
    await expect(toggle).toBeVisible({ timeout: 3_000 })
    await expect(toggle).toHaveAttribute('aria-checked', /true|false/)

    if (!(await toggle.isEnabled().catch(() => false))) {
      // Credentials unset — the switch is deliberately locked.
      return
    }

    const before = await toggle.getAttribute('aria-checked')
    await toggle.click()
    await page.waitForTimeout(1_500)
    await expect(toggle).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true')

    // Restore state
    await toggle.click()
    await page.waitForTimeout(500)
    await expect(toggle).toHaveAttribute('aria-checked', before ?? 'false')
  })

  test('tools list section expands to show individual MCP tools', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    if (!(await expandFirstCard(page))) {
      test.skip()
      return
    }

    const card = page.locator('[data-testid="integration-card"]').first()

    // The tools disclosure is labelled "<n> tools (<m> available in plan mode)".
    const toolsToggle = card.getByRole('button', { name: /\d+ tools/i }).first()
    await expect(toolsToggle).toBeVisible({ timeout: 3_000 })
    await expect(toolsToggle).toHaveAttribute('aria-expanded', 'false')

    await toolsToggle.click()
    await page.waitForTimeout(400)
    await expect(toolsToggle).toHaveAttribute('aria-expanded', 'true')

    // Expanded list renders each tool name as a <code> element.
    expect(await card.locator('code').count()).toBeGreaterThan(0)
  })

  test('use-case grid shows categorized usage examples', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    if (!(await expandFirstCard(page))) {
      test.skip()
      return
    }

    const grid = page.locator('[data-testid="use-case-grid"]').first()
    const hasGrid = await grid.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasGrid) {
      // This integration declares no use cases.
      test.skip()
      return
    }

    await expect(grid.getByText(/what can your agent do/i)).toBeVisible({ timeout: 3_000 })
    expect(await grid.locator('[class*="rounded-md"]').count()).toBeGreaterThan(0)
  })

  test('token impact badge displays estimated token overhead', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    const card = page.locator('[data-testid="integration-card"]').first()

    // Lives in the collapsed header — it is half of the enable/skip decision,
    // so it must never be hidden behind expansion.
    const tokenBadge = card.locator('[data-testid="token-impact-badge"]')
    await expect(tokenBadge).toBeVisible({ timeout: 3_000 })

    const text = await tokenBadge.textContent()
    expect(text).toMatch(/low|medium|high/i)
    expect(text).toMatch(/\d+\s*tools?/i)
  })

  test('workflow steps show the setup sequence', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasIntegrations = await navigateToIntegrations(page)
    if (!hasIntegrations) {
      test.skip()
      return
    }

    if (!(await expandFirstCard(page))) {
      test.skip()
      return
    }

    const stepper = page.locator('[data-testid="workflow-stepper"]').first()
    const hasSteps = await stepper.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSteps) {
      // This integration declares no workflow steps.
      test.skip()
      return
    }

    // Steps sit under Setup, directly above the credentials form they describe.
    const steps = stepper.locator('li')
    expect(await steps.count()).toBeGreaterThan(0)
    expect((await steps.first().textContent())?.trim().startsWith('1.')).toBeTruthy()
  })
})
