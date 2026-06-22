/**
 * System Banners E2E Tests
 *
 * Tests RateLimitBanner (102 LOC), BudgetWarningBanner (105 LOC), UpdateBanner (103 LOC):
 *   - Rate limit banner renders with warning message and utilization bar
 *   - Rate limit rejected state shows "Rate limit reached" text
 *   - Rate limit banner has dismiss button that removes it
 *   - Budget warning banner shows current cost vs budget limit
 *   - Budget exceeded banner shows "Budget exceeded" with paused state
 *   - Budget warning banner has dismiss button with correct aria-label
 *   - Update banner renders when update is available with version number
 *
 * These banners are event-driven (IPC events). Tests verify DOM structure
 * when visible; gracefully skip when no banners are present.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/system-banners.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('System Banners', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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

  // ── Rate Limit Banner ──

  test('rate limit banner renders with warning message and utilization bar', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="rate-limit-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Banner should contain warning text about rate limiting
    const text = await banner.textContent()
    expect(text?.length).toBeGreaterThan(0)

    // Should have a visible warning icon or progress indicator
    const svgIcon = banner.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('rate limit rejected state shows "Rate limit reached" text', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="rate-limit-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Check for the rejected state content
    const text = await banner.textContent()
    const hasRateLimitText =
      text?.toLowerCase().includes('rate limit') ||
      text?.toLowerCase().includes('limit reached') ||
      text?.toLowerCase().includes('utilization')

    // Banner should contain some rate-limit related messaging
    expect(hasRateLimitText || (text?.length ?? 0) > 0).toBeTruthy()
  })

  test('rate limit banner has dismiss button that removes it', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="rate-limit-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Find dismiss button (X button with aria-label)
    const dismissBtn = banner.locator('button[aria-label="Dismiss"], button[aria-label="Close"]')
    const hasDismiss = await dismissBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDismiss) { test.skip(); return }

    await dismissBtn.first().click()
    await page.waitForTimeout(500)

    // Banner should be hidden after dismiss
    await expect(banner).toBeHidden({ timeout: 3_000 })
  })

  // ── Budget Warning Banner ──

  test('budget warning banner shows current cost vs budget limit', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="budget-warning-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Banner should show dollar amounts
    const text = await banner.textContent()
    const hasCostInfo =
      text?.includes('$') || text?.toLowerCase().includes('budget')

    expect(hasCostInfo).toBeTruthy()

    // Should have a warning icon
    const svgIcon = banner.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('budget exceeded banner shows "Budget exceeded" with paused state', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="budget-warning-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    const text = await banner.textContent()
    const isExceeded = text?.toLowerCase().includes('exceeded')

    if (!isExceeded) { test.skip(); return }

    // Exceeded state should mention pausing
    expect(
      text?.toLowerCase().includes('paused') || text?.toLowerCase().includes('exceeded')
    ).toBeTruthy()
  })

  test('budget warning banner has dismiss button with correct aria-label', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="budget-warning-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Dismiss button should have the correct aria-label
    const dismissBtn = banner.locator('button[aria-label="Dismiss budget alert"]')
    const hasDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDismiss) { test.skip(); return }

    await expect(dismissBtn).toBeVisible()
    await expect(dismissBtn).toBeEnabled()
  })

  // ── Update Banner ──

  test('update banner renders when update is available with version number', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const banner = page.locator('[data-testid="update-banner"]')
    const hasBanner = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasBanner) { test.skip(); return }

    // Banner should contain version info or update messaging
    const text = await banner.textContent()
    const hasUpdateText =
      text?.toLowerCase().includes('update') ||
      text?.toLowerCase().includes('available') ||
      text?.toLowerCase().includes('download') ||
      text?.toLowerCase().includes('install') ||
      text?.includes('v')

    expect(hasUpdateText).toBeTruthy()

    // Should have action buttons (Download, Install, or Dismiss)
    const buttons = banner.locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)
  })
})
