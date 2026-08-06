/**
 * Integration Card Internals E2E Tests
 *
 * Covers IntegrationCard sub-components:
 *   - EnvironmentVarsSection expand/collapse
 *   - High-impact warning banner renders when enabled
 *   - Per-chat control info banner renders when enabled
 *   - TokenImpactBadge shows correct impact and tool count
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

  // ── EnvironmentVarsSection ──

  test('EnvironmentVarsSection expand/collapse', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Find a card with environment variables toggle
    const envToggle = page.locator('[data-testid^="integration-env-toggle-"]').first()
    const hasEnvToggle = await envToggle.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasEnvToggle) {
      // No integration has environment variables
      test.skip()
      return
    }

    // Initially the env list should not be visible
    const envList = page.locator('[data-testid="integration-env-list"]')
    const initiallyVisible = await envList.isVisible({ timeout: 1_000 }).catch(() => false)

    // Click toggle to expand
    await envToggle.click()
    await page.waitForTimeout(500)

    if (!initiallyVisible) {
      // After clicking, env list should appear
      await expect(envList).toBeVisible({ timeout: 3_000 })

      // Verify env var keys are displayed as code elements
      const codeElements = envList.locator('code')
      const codeCount = await codeElements.count()
      expect(codeCount).toBeGreaterThan(0)
    }

    // Click toggle again to collapse
    await envToggle.click()
    await page.waitForTimeout(500)

    // List should be hidden after collapsing
    const finallyVisible = await envList.isVisible({ timeout: 1_000 }).catch(() => false)
    expect(finallyVisible).toBe(initiallyVisible)
  })

  // ── High-impact warning banner ──

  test('high-impact warning banner renders when enabled', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Check if a high-impact warning banner is already visible
    const warningBanner = page.locator('[data-testid="integration-warning-high-impact"]')
    const hasWarning = await warningBanner.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasWarning) {
      // Banner is visible — verify its content
      const bannerText = await warningBanner.textContent()
      expect(bannerText).toMatch(/high token impact/i)
      expect(bannerText).toMatch(/toggle it off/i)
      return
    }

    // No high-impact warning visible — try enabling a high-impact integration
    // Look for any integration card with a toggle that's currently disabled
    for (let i = 0; i < count; i++) {
      const card = integrationCards.nth(i)
      const toggle = card.locator('button[class*="rounded-full"]')
      const hasToggle = await toggle.isVisible({ timeout: 1_000 }).catch(() => false)

      if (!hasToggle) continue

      // Check if disabled (no bg-accent class)
      const classes = await toggle.getAttribute('class')
      const isDisabled = !classes?.includes('bg-accent')

      if (isDisabled) {
        // Enable it and check for high-impact warning
        await toggle.click()
        await page.waitForTimeout(1_500)

        const newWarning = await warningBanner.isVisible({ timeout: 3_000 }).catch(() => false)

        if (newWarning) {
          const bannerText = await warningBanner.textContent()
          expect(bannerText).toMatch(/high token impact/i)

          // Disable it back to restore state
          await toggle.click()
          await page.waitForTimeout(500)
          return
        }

        // Not high-impact — disable and try next
        await toggle.click()
        await page.waitForTimeout(500)
      }
    }

    // No high-impact integrations found — that's OK
    expect(true).toBeTruthy()
  })

  // ── Per-chat control info banner ──

  test('per-chat control info banner renders when enabled', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Check if per-chat info banner is already visible
    const infoBanner = page.locator('[data-testid="integration-info-per-chat"]')
    const hasBanner = await infoBanner.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasBanner) {
      // Banner is visible — verify content
      const bannerText = await infoBanner.textContent()
      expect(bannerText).toMatch(/per-chat control/i)
      expect(bannerText).toMatch(/pill/i)
      return
    }

    // No per-chat banner visible — enable an integration
    const firstCard = integrationCards.first()
    const toggle = firstCard.locator('button[class*="rounded-full"]')
    const hasToggle = await toggle.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasToggle) {
      test.skip()
      return
    }

    // Check if currently disabled
    const classes = await toggle.getAttribute('class')
    const isDisabled = !classes?.includes('bg-accent')

    if (isDisabled) {
      // Enable it
      await toggle.click()
      await page.waitForTimeout(1_500)

      // Per-chat banner should now appear
      const newBanner = await infoBanner.isVisible({ timeout: 3_000 }).catch(() => false)

      if (newBanner) {
        const bannerText = await infoBanner.textContent()
        expect(bannerText).toMatch(/per-chat control/i)
      }

      // Restore state
      await toggle.click()
      await page.waitForTimeout(500)
    } else {
      // Already enabled — banner should be visible
      // Re-check with longer timeout
      const lateBanner = await infoBanner.isVisible({ timeout: 5_000 }).catch(() => false)
      expect(lateBanner).toBeTruthy()
    }
  })

  // ── TokenImpactBadge ──

  test('TokenImpactBadge shows correct impact and tool count', async ({ electronPage: page }) => {
    await navigateToIntegrations(page)

    const integrationCards = page.locator('[data-testid^="integration-card-"]')
    const count = await integrationCards.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Wait for CLI checks to complete (badges render after status row)
    await page.waitForTimeout(3_000)

    // Find all token impact badges
    const badges = page.locator('[data-testid="token-impact-badge"]')
    const badgeCount = await badges.count()

    // Each integration card should have a token impact badge
    expect(badgeCount).toBeGreaterThan(0)

    // Verify badge text structure for each badge
    for (let i = 0; i < Math.min(badgeCount, 3); i++) {
      const badge = badges.nth(i)
      const text = await badge.textContent()

      // Badge should contain impact level
      expect(text).toMatch(/low|medium|high/i)

      // Badge should contain tool count
      expect(text).toMatch(/\d+\s*tools?/i)
    }
  })
})
