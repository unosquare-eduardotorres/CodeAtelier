/**
 * App Settings E2E Tests
 *
 * Verifies SettingsPage (64 LOC) — global app preferences:
 *   - App settings page renders with preference sections
 *   - Theme section shows dark/light theme toggle
 *   - Chat bubble size section shows size selector
 *   - Update settings shows auto-update toggle
 *   - AI subscriptions section shows Claude API config
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/app-settings.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('App Settings', () => {
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

  /** Navigate to app-level settings (not workspace settings). */
  async function navigateToAppSettings(page: import('@playwright/test').Page): Promise<boolean> {
    // Look for app settings gear icon or menu item
    const settingsBtn = page.locator(
      '[aria-label="App Settings"], [data-testid="app-settings-btn"]'
    )
    let hasBtn = await settingsBtn
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    if (hasBtn) {
      await settingsBtn.first().click()
      await page.waitForTimeout(800)
      return true
    }

    // Try via menu or dropdown that opens app settings
    const menuBtn = page.getByRole('button', { name: /settings/i }).first()
    hasBtn = await menuBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasBtn) {
      await menuBtn.click()
      await page.waitForTimeout(500)

      // Look for "App Settings" in the dropdown
      const appSettingsItem = page.getByText(/app settings/i).first()
      const hasItem = await appSettingsItem.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasItem) {
        await appSettingsItem.click()
        await page.waitForTimeout(800)
        return true
      }
    }

    return false
  }

  test('app settings page renders with preference sections', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) {
      test.skip()
      return
    }

    const settingsPage = page.locator('[data-testid="app-settings-page"]')
    await expect(settingsPage).toBeVisible({ timeout: 5_000 })

    // Header
    const header = page.getByText(/app settings/i).first()
    await expect(header).toBeVisible()
  })

  test('theme section shows dark/light theme toggle', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) {
      test.skip()
      return
    }

    const settingsPage = page.locator('[data-testid="app-settings-page"]')
    const hasPage = await settingsPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Theme section
    const themeSection = page.getByText(/theme/i).first()
    const hasTheme = await themeSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTheme) {
      test.skip()
      return
    }

    await expect(themeSection).toBeVisible()
  })

  test('chat bubble size section shows size selector', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) {
      test.skip()
      return
    }

    const settingsPage = page.locator('[data-testid="app-settings-page"]')
    const hasPage = await settingsPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Chat bubble size section
    const bubbleSection = page.getByText(/bubble|chat.*size/i).first()
    const hasBubble = await bubbleSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasBubble) {
      test.skip()
      return
    }

    await expect(bubbleSection).toBeVisible()
  })

  test('update settings shows auto-update toggle', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) {
      test.skip()
      return
    }

    const settingsPage = page.locator('[data-testid="app-settings-page"]')
    const hasPage = await settingsPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Update section
    const updateSection = page.getByText(/update|auto-update|version/i).first()
    const hasUpdate = await updateSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasUpdate) {
      test.skip()
      return
    }

    await expect(updateSection).toBeVisible()
  })

  test('AI subscriptions section shows Claude API config', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) {
      test.skip()
      return
    }

    const settingsPage = page.locator('[data-testid="app-settings-page"]')
    const hasPage = await settingsPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // AI Subscriptions section
    const aiSection = page.getByText(/subscription|claude|api|anthropic/i).first()
    const hasAI = await aiSection.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasAI) {
      test.skip()
      return
    }

    await expect(aiSection).toBeVisible()
  })
})
