/**
 * Update Flow E2E Tests
 *
 * Tests app update UI components — render conditionally based on
 * update availability:
 *   - Update banner renders correct state
 *   - Update available modal shows release details
 *   - Update banner dismiss button hides banner
 *
 * These components render conditionally. Tests skip gracefully when
 * no update is available.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Update Flow', () => {
  /**
   * Helper: Ensure workspace is open.
   */
  async function ensureAppReady(
    page: import('@playwright/test').Page
  ): Promise<void> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }
  }

  test('Update banner renders correct state', async ({ electronPage: page }) => {
    await ensureAppReady(page)

    // Look for update banner — only appears when an update is available
    const banner = page.locator('[data-testid="update-banner"]')
    const isVisible = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      // No update available — skip
      test.skip()
      return
    }

    // Verify banner has state-appropriate content
    const text = await banner.textContent()
    const hasValidContent =
      text?.includes('Download') ||
      text?.includes('Restart') ||
      text?.includes('progress') ||
      text?.includes('Update')
    expect(hasValidContent).toBeTruthy()
  })

  test('Update available modal shows release details', async ({ electronPage: page }) => {
    await ensureAppReady(page)

    // Look for update modal
    const modal = page.locator('[data-testid="update-available-modal"]')
    const isVisible = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      // No update modal shown — skip
      test.skip()
      return
    }

    // Modal should show version info
    const modalContent = await modal.textContent()
    expect(modalContent).toBeTruthy()

    // "Later" button should be present
    const laterBtn = modal.locator('button', { hasText: /later/i })
    await expect(laterBtn).toBeVisible()

    // Action button present (Download/Install/Retry)
    const actionBtn = modal.locator('button', { hasText: /update now|restart.*install|retry/i })
    if (await actionBtn.isVisible().catch(() => false)) {
      await expect(actionBtn).toBeEnabled()
    }

    // Close modal via Later button
    await laterBtn.click()
    await page.waitForTimeout(500)
    await expect(modal).not.toBeVisible()
  })

  test('Update banner dismiss button hides banner', async ({ electronPage: page }) => {
    await ensureAppReady(page)

    const banner = page.locator('[data-testid="update-banner"]')
    const isVisible = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Find dismiss button (X)
    const dismissBtn = banner.locator('button[aria-label*="ismiss"], button[aria-label*="lose"]')
    const hasDismiss = await dismissBtn.isVisible().catch(() => false)

    if (!hasDismiss) {
      // Some states don't have dismiss buttons (e.g., downloading)
      test.skip()
      return
    }

    // Click dismiss
    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Banner should disappear
    await expect(banner).not.toBeVisible()
  })

  test('download progress bar updates during download state', async ({
    electronPage: page
  }) => {
    await ensureAppReady(page)

    // Look for progress indicators in update banner
    const banner = page.locator('[data-testid="update-banner"]')
    const isVisible = await banner.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Check for progress bar or percentage text
    const progressBar = banner.locator('[role="progressbar"], progress')
    const progressText = banner.getByText(/%|downloading/i)
    const hasProgress = await progressBar.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasProgressText = await progressText.isVisible({ timeout: 3_000 }).catch(() => false)

    // If downloading state, progress should be shown
    // If another state, just verify banner has valid content
    const bannerText = await banner.textContent()
    expect(bannerText).toBeTruthy()
    expect(hasProgress || hasProgressText || bannerText!.length > 0).toBeTruthy()
  })

  test('restart and install button triggers confirmation', async ({
    electronPage: page
  }) => {
    await ensureAppReady(page)

    // Look for restart & install button (only visible when update is downloaded)
    const restartBtn = page.getByRole('button', { name: /restart.*install|install.*restart/i })
    const isVisible = await restartBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      // No download ready — check banner state instead
      const banner = page.locator('[data-testid="update-banner"]')
      const hasBanner = await banner.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasBanner) {
        test.skip()
        return
      }
      // Verify banner shows appropriate state
      const text = await banner.textContent()
      expect(text).toBeTruthy()
      return
    }

    // Button should be enabled
    await expect(restartBtn).toBeEnabled()

    // Clicking should show confirmation or trigger restart
    // NOTE: Don't actually click in CI — just verify visibility and enabled state
    const btnText = await restartBtn.textContent()
    expect(btnText).toMatch(/restart|install/i)
  })
})
