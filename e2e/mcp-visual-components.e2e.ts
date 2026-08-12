/**
 * MCP Visual Components E2E Tests — Tier C
 *
 * Verifies the visual sub-components within integration cards:
 *   1. UseCaseGrid renders use-case cards with icons
 *   2. The workflow step list renders numbered setup steps in order
 *   3. McpExplainerBanner exposes its explanation through the help popover
 *   4. Use-case cards survive interaction
 *   5. A collapsed card body stays unmounted until expanded
 *
 * Integration cards are collapsed by default — everything below the header row
 * is only mounted on expand. Every body assertion here must expand first;
 * before that these tests "passed" by skipping past absent selectors.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/mcp-visual-components.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('MCP Visual Components', () => {
  // ── Shared helpers ────────────────────────────────────────────────

  async function navigateToIntegrations(page: import('@playwright/test').Page): Promise<void> {
    const welcomePage = new WelcomePage(page)
    const settings = new WorkspaceSettings(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('integrations')
    await page.waitForTimeout(500)
  }

  /**
   * Expand the nth integration card. Idempotent — reads `aria-expanded` rather
   * than blind-clicking, so calling it on an open card does not close it.
   */
  async function expandIntegrationCard(
    page: import('@playwright/test').Page,
    index = 0
  ): Promise<boolean> {
    const expanders = page.locator('[data-testid^="integration-expand-"]')
    if ((await expanders.count()) <= index) return false

    const expander = expanders.nth(index)
    if ((await expander.getAttribute('aria-expanded')) !== 'true') {
      await expander.click()
      await page.waitForTimeout(400)
    }
    return true
  }

  /** Expand cards in turn until `testid` shows up. Returns the card index, or -1. */
  async function expandUntilVisible(
    page: import('@playwright/test').Page,
    testid: string
  ): Promise<number> {
    const total = await page.locator('[data-testid^="integration-expand-"]').count()
    for (let i = 0; i < total; i++) {
      if (!(await expandIntegrationCard(page, i))) break
      const found = await page
        .locator(`[data-testid="${testid}"]`)
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)
      if (found) return i
    }
    return -1
  }

  // ── 1. UseCaseGrid renders use-case cards with icons ──────────────

  test('UseCaseGrid renders use-case cards with icons', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const index = await expandUntilVisible(page, 'use-case-grid')
    if (index === -1) {
      test.skip()
      return
    }

    const useCaseGrid = page.locator('[data-testid="use-case-grid"]').first()
    await expect(useCaseGrid).toBeVisible()

    // Verify the grid header
    await expect(useCaseGrid.getByText(/what can your agent do/i)).toBeVisible({ timeout: 3_000 })

    // Grid should contain use-case cards, each with an icon and a title
    const useCaseCards = useCaseGrid.locator('[class*="rounded-md"]')
    const cardCount = await useCaseCards.count()
    expect(cardCount).toBeGreaterThan(0)

    const firstUseCase = useCaseCards.first()
    await expect(firstUseCase.locator('svg').first()).toBeVisible({ timeout: 2_000 })
    const useCaseText = await firstUseCase.textContent()
    expect(useCaseText?.trim().length).toBeGreaterThan(0)
  })

  // ── 2. Workflow steps render numbered, in registry order ──────────

  test('workflow steps render as a numbered setup list', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const index = await expandUntilVisible(page, 'workflow-stepper')
    if (index === -1) {
      test.skip()
      return
    }

    const stepper = page.locator('[data-testid="workflow-stepper"]').first()
    await expect(stepper).toBeVisible()

    // The steps live under Setup now — the old standalone "How it works" block
    // duplicated the page-level explainer and was removed.
    const steps = stepper.locator('li')
    const stepCount = await steps.count()
    expect(stepCount).toBeGreaterThan(0)

    // Numbering must be sequential from 1 — the old flex-wrap stepper rendered
    // a broken staircase with arrows pointing into empty space.
    for (let i = 0; i < stepCount; i++) {
      const text = await steps.nth(i).textContent()
      expect(text?.trim().startsWith(`${i + 1}.`)).toBeTruthy()
      expect(text?.trim().length).toBeGreaterThan(2)
    }
  })

  // ── 3. McpExplainerBanner exposes MCP explanation via popover ─────

  test('McpExplainerBanner renders MCP explanation content', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const banner = page.locator('[data-testid="mcp-explainer-banner"]')
    await expect(banner).toBeVisible({ timeout: 5_000 })

    // The collapsed header keeps only the title.
    await expect(banner.getByText(/external mcp integrations/i)).toBeVisible({ timeout: 3_000 })

    // Everything else moved behind the help affordance — it is onboarding copy,
    // read once, and used to cost a permanent ~320px banner.
    await banner.getByRole('button', { name: /what is mcp/i }).click()

    const popover = page.locator('[data-testid="mcp-explainer-popover"]')
    await expect(popover).toBeVisible({ timeout: 3_000 })

    await expect(popover.getByText(/what is mcp/i)).toBeVisible({ timeout: 3_000 })
    await expect(popover.getByText(/model context protocol/i)).toBeVisible({ timeout: 3_000 })
    await expect(popover.getByText(/how it works/i)).toBeVisible({ timeout: 3_000 })

    // Four numbered flow steps + the token-cost note.
    const steps = popover.locator('li')
    expect(await steps.count()).toBe(4)
    await expect(popover.getByText(/token cost/i)).toBeVisible({ timeout: 3_000 })

    // Escape dismisses it — it must not become a permanent row again.
    await page.keyboard.press('Escape')
    await expect(popover).toBeHidden({ timeout: 3_000 })
  })

  // ── 4. Use-case cards survive interaction ─────────────────────────

  test('use-case cards are inert and do not collapse the card', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const index = await expandUntilVisible(page, 'use-case-grid')
    if (index === -1) {
      test.skip()
      return
    }

    const useCaseGrid = page.locator('[data-testid="use-case-grid"]').first()
    const useCaseCards = useCaseGrid.locator('[class*="rounded-md"]')
    if ((await useCaseCards.count()) === 0) {
      test.skip()
      return
    }

    await useCaseCards.first().click()
    await page.waitForTimeout(500)

    // Use-case cards are descriptive, not navigational: clicking one must not
    // collapse the card out from under the reader.
    await expect(useCaseGrid).toBeVisible()
  })

  // ── 5. Collapsed cards keep their body unmounted ──────────────────

  test('card body stays unmounted until the row is expanded', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const expanders = page.locator('[data-testid^="integration-expand-"]')
    if ((await expanders.count()) === 0) {
      test.skip()
      return
    }

    const first = expanders.first()

    // Collapse it if a previous run left it open.
    if ((await first.getAttribute('aria-expanded')) === 'true') {
      await first.click()
      await page.waitForTimeout(300)
    }

    await expect(first).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-testid="use-case-grid"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="workflow-stepper"]')).toHaveCount(0)

    // The header still carries the decision-making signals.
    await expect(page.locator('[data-testid="token-impact-badge"]').first()).toBeVisible({
      timeout: 3_000
    })

    await first.click()
    await page.waitForTimeout(400)
    await expect(first).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('[data-testid="workflow-stepper"]').first()).toBeVisible({
      timeout: 3_000
    })
  })
})
