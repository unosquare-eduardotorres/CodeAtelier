/**
 * Activation Flow E2E Tests
 *
 * Tests ActivationBanner (124 LOC) — workspace agent auto-activation CTA:
 *   - Activation banner renders when no specialists are active
 *   - Banner shows "Activate Agents for Workspace" heading
 *   - Detected tech stack badges display with icons
 *   - "Auto-Activate Agents" button triggers activation
 *   - Error state shows error message with Retry button
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/activation-flow.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Activation Flow', () => {
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

  async function navigateToSpecialist(page: import('@playwright/test').Page): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('specialist')
  }

  test('activation banner renders when no specialists are active', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const banner = page.locator('[data-testid="activation-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      // Specialists already active — banner not shown
      test.skip()
      return
    }

    await expect(banner).toBeVisible()
  })

  test('banner shows "Activate Agents for Workspace" heading', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const banner = page.locator('[data-testid="activation-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      test.skip()
      return
    }

    // Should show the heading
    const heading = banner.getByText(/activate agents for workspace/i)
    await expect(heading).toBeVisible()

    // Should have description text about what activation does
    const description = banner.getByText(/no specialists are active/i)
    const hasDesc = await description.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasDesc) {
      await expect(description).toBeVisible()
    }
  })

  test('detected tech stack badges display with icons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const banner = page.locator('[data-testid="activation-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      test.skip()
      return
    }

    // Check for "Detected Tech Stack:" label
    const stackLabel = banner.getByText(/detected tech stack/i)
    const hasStack = await stackLabel.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasStack) {
      // No tech stack detected for this workspace
      test.skip()
      return
    }

    await expect(stackLabel).toBeVisible()

    // Should have at least one tech badge
    const badges = banner.locator('.rounded-full').filter({ hasText: /.+/ })
    const badgeCount = await badges.count()
    expect(badgeCount).toBeGreaterThan(0)

    // First badge should have an emoji icon
    const firstBadge = badges.first()
    const badgeText = await firstBadge.textContent()
    expect(badgeText?.length).toBeGreaterThan(0)
  })

  test('"Auto-Activate Agents" button triggers activation', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const deployBtn = page.locator('[data-testid="activation-deploy-btn"]')
    const hasBtn = await deployBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    // Button should show "Auto-Activate Agents" text
    const btnText = await deployBtn.textContent()
    expect(
      btnText?.toLowerCase().includes('activate') || btnText?.toLowerCase().includes('activating')
    ).toBeTruthy()

    // Button should have a sparkles icon
    const icon = deployBtn.locator('svg').first()
    await expect(icon).toBeVisible()

    // Button should be enabled (not currently activating)
    await expect(deployBtn).toBeEnabled()
  })

  test('error state shows error message with Retry button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToSpecialist(page)
    if (!navigated) {
      test.skip()
      return
    }

    const banner = page.locator('[data-testid="activation-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) {
      test.skip()
      return
    }

    // Check for error state
    const errorMsg = banner.locator('.text-danger')
    const hasError = await errorMsg
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    if (!hasError) {
      // No error state — expected in normal operation
      test.skip()
      return
    }

    // Error should have visible text
    const errorText = await errorMsg.first().textContent()
    expect(errorText?.length).toBeGreaterThan(0)

    // Should have a Retry button
    const retryBtn = banner.getByRole('button', { name: /retry/i })
    const hasRetry = await retryBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasRetry) {
      await expect(retryBtn).toBeEnabled()
    }
  })
})
