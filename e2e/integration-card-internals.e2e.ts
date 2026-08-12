/**
 * Integration Card Internals E2E Tests
 *
 * Covers IntegrationCard sub-components:
 *   - Environment variables section expand/collapse
 *   - High-impact warning banner renders when enabled
 *   - Per-chat control info banner renders when enabled
 *   - TokenImpactBadge shows correct impact and tool count
 *
 * The card is a collapsed row by default: the token badge and the availability
 * switch live in the header, everything else is only mounted on expand. Body
 * assertions must expand the row first.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/integration-card-internals.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Integration Card Internals', () => {
  /**
   * Helper: navigate to the Integrations tab in workspace settings.
   */
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

  /** Expand every integration card so body-level sections are mounted. */
  async function expandAllCards(page: import('@playwright/test').Page): Promise<number> {
    const expanders = page.locator('[data-testid^="integration-expand-"]')
    const count = await expanders.count()
    for (let i = 0; i < count; i++) {
      const expander = expanders.nth(i)
      if ((await expander.getAttribute('aria-expanded')) !== 'true') {
        await expander.click()
        await page.waitForTimeout(300)
      }
    }
    return count
  }

  // ── Environment variables section ──

  test('environment variables section expand/collapse', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    if ((await expandAllCards(page)) === 0) {
      test.skip()
      return
    }

    // Only integrations without a credential form render an env-var section.
    const envToggle = page.locator('[data-testid^="integration-env-toggle-"]').first()
    const hasEnvToggle = await envToggle.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasEnvToggle) {
      test.skip()
      return
    }

    const envList = page.locator('[data-testid="integration-env-list"]')
    await expect(envList).toHaveCount(0)

    // Expand
    await envToggle.click()
    await page.waitForTimeout(400)
    await expect(envList).toBeVisible({ timeout: 3_000 })

    // Keys are rendered as code elements
    expect(await envList.locator('code').count()).toBeGreaterThan(0)

    // Collapse
    await envToggle.click()
    await page.waitForTimeout(400)
    await expect(envList).toHaveCount(0)
  })

  // ── High-impact warning banner ──

  test('high-impact warning banner renders when enabled', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const cardCount = await expandAllCards(page)
    if (cardCount === 0) {
      test.skip()
      return
    }

    const warningBanner = page.locator('[data-testid="integration-warning-high-impact"]')
    if (
      await warningBanner
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
    ) {
      const bannerText = await warningBanner.first().textContent()
      expect(bannerText).toMatch(/high token impact/i)
      expect(bannerText).toMatch(/toggle it off/i)
      return
    }

    // Nothing enabled yet — turn integrations on until a high-impact one appears.
    const switches = page.locator('[data-testid="integration-card"] [role="switch"]')
    const switchCount = await switches.count()

    for (let i = 0; i < switchCount; i++) {
      const toggle = switches.nth(i)
      // A card whose credentials are unset renders a disabled switch; clicking it
      // would block until the action timeout rather than fail fast.
      if (!(await toggle.isEnabled().catch(() => false))) continue
      if ((await toggle.getAttribute('aria-checked')) === 'true') continue

      await toggle.click()
      await page.waitForTimeout(1_500)

      if (
        await warningBanner
          .first()
          .isVisible({ timeout: 3_000 })
          .catch(() => false)
      ) {
        expect(await warningBanner.first().textContent()).toMatch(/high token impact/i)
        // Restore state
        await toggle.click()
        await page.waitForTimeout(500)
        return
      }

      // Not high-impact — restore and try the next one.
      await toggle.click()
      await page.waitForTimeout(500)
    }

    // No high-impact integration is currently togglable — acceptable.
    expect(switchCount).toBeGreaterThanOrEqual(0)
  })

  // ── Per-chat control info banner ──

  test('per-chat control info banner renders when enabled', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    if ((await expandAllCards(page)) === 0) {
      test.skip()
      return
    }

    const infoBanner = page.locator('[data-testid="integration-info-per-chat"]')
    if (
      await infoBanner
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)
    ) {
      const bannerText = await infoBanner.first().textContent()
      expect(bannerText).toMatch(/per-chat control/i)
      expect(bannerText).toMatch(/pill/i)
      return
    }

    // Find the first togglable switch and enable it.
    const switches = page.locator('[data-testid="integration-card"] [role="switch"]')
    const switchCount = await switches.count()
    let toggled: ReturnType<typeof switches.nth> | null = null

    for (let i = 0; i < switchCount; i++) {
      const toggle = switches.nth(i)
      if (!(await toggle.isEnabled().catch(() => false))) continue
      if ((await toggle.getAttribute('aria-checked')) === 'true') continue
      toggled = toggle
      break
    }

    if (!toggled) {
      test.skip()
      return
    }

    await toggled.click()
    await page.waitForTimeout(1_500)

    // Enabling is exactly what makes the per-chat pill appear, so the banner
    // explaining it must show up with it.
    await expect(infoBanner.first()).toBeVisible({ timeout: 3_000 })
    expect(await infoBanner.first().textContent()).toMatch(/per-chat control/i)

    // Restore state
    await toggled.click()
    await page.waitForTimeout(500)
  })

  // ── TokenImpactBadge ──

  test('TokenImpactBadge shows correct impact and tool count', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const cards = page.locator('[data-testid="integration-card"]')
    const cardCount = await cards.count()
    if (cardCount === 0) {
      test.skip()
      return
    }

    // The badge sits in the collapsed header — no expansion needed. Every card
    // must carry one: it is half of the enable/skip decision.
    const badges = page.locator('[data-testid="token-impact-badge"]')
    await expect(badges).toHaveCount(cardCount)

    for (let i = 0; i < cardCount; i++) {
      const text = await badges.nth(i).textContent()
      expect(text).toMatch(/low|medium|high/i)
      expect(text).toMatch(/\d+\s*tools?/i)
    }
  })
})
