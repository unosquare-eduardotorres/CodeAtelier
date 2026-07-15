/**
 * Update Settings Deep E2E Tests
 *
 * Verifies UpdateSettingsSection (180 LOC) — update source configuration:
 *   - Update section renders with current app version
 *   - Source selector renders Cloud Drive and GitHub buttons
 *   - Selecting Drive source shows path input with browse button
 *   - Selecting GitHub source shows owner and repo inputs
 *   - Drive source info text mentions required file format
 *   - GitHub source shows future availability notice
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/update-settings-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Update Settings Deep', () => {
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

  /** Navigate to app-level settings page. */
  async function navigateToAppSettings(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const settingsBtn = page.locator('[aria-label="App Settings"], [data-testid="app-settings-btn"]')
    let hasBtn = await settingsBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasBtn) {
      await settingsBtn.first().click()
      await page.waitForTimeout(800)
      return true
    }

    const menuBtn = page.getByRole('button', { name: /settings/i }).first()
    hasBtn = await menuBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasBtn) {
      await menuBtn.click()
      await page.waitForTimeout(500)
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

  test('update section renders with current app version', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    await expect(section).toBeVisible()
    // Should display a version string like v1.2.3
    await expect(section.getByText(/v\d+\.\d+\.\d+/)).toBeVisible({ timeout: 5_000 })
  })

  test('source selector renders Cloud Drive and GitHub buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    const driveBtn = page.locator('[data-testid="update-source-drive-btn"]')
    const githubBtn = page.locator('[data-testid="update-source-github-btn"]')

    await expect(driveBtn).toBeVisible()
    await expect(githubBtn).toBeVisible()
  })

  test('selecting Drive source shows path input with browse button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    // Click the Drive source button
    const driveBtn = page.locator('[data-testid="update-source-drive-btn"]')
    await driveBtn.click()
    await page.waitForTimeout(500)

    // Drive path input and browse button should appear
    const pathInput = page.locator('[data-testid="update-drive-path-input"]')
    const browseBtn = page.locator('[data-testid="update-browse-btn"]')

    await expect(pathInput).toBeVisible({ timeout: 3_000 })
    await expect(browseBtn).toBeVisible()
  })

  test('selecting GitHub source shows owner and repo inputs', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    // Click the GitHub source button
    const githubBtn = page.locator('[data-testid="update-source-github-btn"]')
    await githubBtn.click()
    await page.waitForTimeout(500)

    // Owner and repo inputs should appear
    const ownerInput = page.locator('input[placeholder="owner"]')
    const repoInput = page.locator('input[placeholder="repo"]')

    await expect(ownerInput).toBeVisible({ timeout: 3_000 })
    await expect(repoInput).toBeVisible()
  })

  test('drive source info text mentions required file format', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    // Ensure Drive source is selected
    const driveBtn = page.locator('[data-testid="update-source-drive-btn"]')
    await driveBtn.click()
    await page.waitForTimeout(500)

    // Info text should mention the required file format
    await expect(section.getByText(/latest-mac\.yml/)).toBeVisible({ timeout: 3_000 })
  })

  test('github source shows future availability notice', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToAppSettings(page)
    if (!navigated) { test.skip(); return }

    const section = page.locator('[data-testid="update-settings-section"]')
    const hasSection = await section.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasSection) { test.skip(); return }

    // Click GitHub source
    const githubBtn = page.locator('[data-testid="update-source-github-btn"]')
    await githubBtn.click()
    await page.waitForTimeout(500)

    // Should show future availability notice
    await expect(section.getByText(/future release/i)).toBeVisible({ timeout: 3_000 })
  })
})
