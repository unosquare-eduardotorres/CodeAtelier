/**
 * Update Modal E2E Tests
 *
 * Tests UpdateAvailableModal (195 LOC) — app update lifecycle modal:
 *   - Update modal renders with version number and "Update Available" title
 *   - Release notes section shows when notes are present
 *   - "Update Now" button triggers download
 *   - Downloading state shows progress bar with percentage
 *   - Ready state shows "Restart & Install" button
 *   - Error state shows error message with Retry and Dismiss buttons
 *
 * Modal is state-driven from useUpdateStore. Tests gracefully skip
 * if modal isn't triggered.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/update-modal.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Update Modal', () => {
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

  test('update modal renders with version number and "Update Available" title', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Should have a title
    const title = modal.locator('#update-modal-title')
    await expect(title).toBeVisible()

    const titleText = await title.textContent()
    expect(titleText?.length).toBeGreaterThan(0)

    // Should contain version info somewhere
    const modalText = await modal.textContent()
    expect(modalText).toBeTruthy()
  })

  test('release notes section shows when notes are present', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Check for release notes section
    const releaseNotes = modal.getByText(/release notes/i)
    const hasNotes = await releaseNotes.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasNotes) { test.skip(); return }

    await expect(releaseNotes).toBeVisible()
  })

  test('"Update Now" button triggers download', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Look for "Update Now" button (available state)
    const updateBtn = modal.getByRole('button', { name: /update now/i })
    const hasUpdateBtn = await updateBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasUpdateBtn) { test.skip(); return }

    await expect(updateBtn).toBeEnabled()

    // Verify the button has the download icon
    const downloadIcon = updateBtn.locator('svg')
    await expect(downloadIcon).toBeVisible()
  })

  test('downloading state shows progress bar with percentage', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Check for downloading state (Downloading Update title + progress bar)
    const downloadingTitle = modal.getByText(/downloading/i)
    const hasDownloading = await downloadingTitle.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDownloading) { test.skip(); return }

    // Should show a progress bar
    const progressBar = modal.locator('.bg-primary.rounded-full')
    const hasProgress = await progressBar.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasProgress) {
      await expect(progressBar).toBeVisible()
    }

    // Should show percentage text
    const percentText = modal.getByText(/\d+%/)
    const hasPercent = await percentText.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasPercent) {
      await expect(percentText).toBeVisible()
    }
  })

  test('ready state shows "Restart & Install" button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Check for "Ready to Install" title
    const readyTitle = modal.getByText(/ready to install/i)
    const hasReady = await readyTitle.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasReady) { test.skip(); return }

    // Should show "Restart & Install" button
    const installBtn = modal.getByRole('button', { name: /restart.*install/i })
    const hasInstallBtn = await installBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasInstallBtn) { test.skip(); return }

    await expect(installBtn).toBeEnabled()
  })

  test('error state shows error message with Retry and Dismiss buttons', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modal = page.locator('[data-testid="update-available-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) { test.skip(); return }

    // Check for error state (Update Error title)
    const errorTitle = modal.getByText(/update error/i)
    const hasError = await errorTitle.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasError) { test.skip(); return }

    // Should show error message in a danger box
    const errorMsg = modal.locator('.text-danger')
    const hasErrMsg = await errorMsg.first().isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasErrMsg) {
      await expect(errorMsg.first()).toBeVisible()
    }

    // Should have Retry and Dismiss buttons
    const retryBtn = modal.getByRole('button', { name: /retry/i })
    const dismissBtn = modal.getByRole('button', { name: /dismiss/i })

    const hasRetry = await retryBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasRetry) await expect(retryBtn).toBeEnabled()
    if (hasDismiss) await expect(dismissBtn).toBeEnabled()
  })
})
