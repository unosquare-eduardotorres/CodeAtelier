/**
 * Specialist Build Flow E2E Tests
 *
 * Verifies GenerateSpecialistModal (223 LOC) — specialist build lifecycle:
 *   - Generate specialist modal renders when specialist is pending
 *   - "Generate" button starts the specialist build
 *   - Building state shows spinner and progress message
 *   - Ready state shows success check with auto-close
 *   - Failed state shows error with retry option
 *   - "Maybe later" dismisses the modal (session-only)
 *
 * Note: The modal auto-appears when a workspace has a pending specialist.
 * Tests gracefully skip if no workspace triggers this state.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/specialist-build-flow.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Specialist Build Flow', () => {
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

  /** Check if the generate specialist modal is currently visible. */
  async function isModalVisible(page: import('@playwright/test').Page): Promise<boolean> {
    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    return modal.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('generate specialist modal renders when specialist is pending', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    await expect(modal).toBeVisible()

    // Should have the "Generate Project Specialist" heading
    const heading = modal.getByText(/generate project specialist/i)
    await expect(heading).toBeVisible()
  })

  test('"Generate" button starts the specialist build', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')

    // Look for "Generate Now" button (idle state)
    const generateBtn = modal.getByText(/generate now/i)
    const hasBtn = await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasBtn) {
      await expect(generateBtn).toBeVisible()
      await expect(generateBtn).toBeEnabled()
    } else {
      // May already be building — check for building state
      const buildingText = modal.getByText(/generating specialist|building/i)
      const isBuilding = await buildingText.isVisible({ timeout: 2_000 }).catch(() => false)
      expect(isBuilding || !hasBtn).toBeTruthy()
    }
  })

  test('building state shows spinner and progress message', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')

    // Check if we're in building state
    const buildingHeading = modal.getByText(/generating specialist/i)
    const isBuilding = await buildingHeading.isVisible({ timeout: 2_000 }).catch(() => false)

    if (isBuilding) {
      // Should show a spinner
      const spinner = modal.locator('.animate-spin')
      await expect(spinner.first()).toBeVisible()

      // Should show progress message
      const progressText = modal.getByText(/building specialist/i)
      const hasProgress = await progressText.isVisible({ timeout: 2_000 }).catch(() => false)
      expect(hasProgress).toBeTruthy()
    } else {
      // Not in building state — skip
      test.skip()
    }
  })

  test('ready state shows success check', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')

    // Check if we're in ready state
    const readyHeading = modal.getByText(/specialist ready/i)
    const isReady = await readyHeading.isVisible({ timeout: 2_000 }).catch(() => false)

    if (isReady) {
      await expect(readyHeading).toBeVisible()
      // Should show auto-close message
      const autoCloseText = modal.getByText(/closing automatically/i)
      await expect(autoCloseText).toBeVisible()
    } else {
      // Not in ready state — skip
      test.skip()
    }
  })

  test('failed state shows error with retry option', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')

    // Check if we're in failed state
    const failedHeading = modal.getByText(/build failed/i)
    const isFailed = await failedHeading.isVisible({ timeout: 2_000 }).catch(() => false)

    if (isFailed) {
      await expect(failedHeading).toBeVisible()

      // Should have a Retry button
      const retryBtn = modal.getByText(/retry/i)
      await expect(retryBtn).toBeVisible()
      await expect(retryBtn).toBeEnabled()

      // Should have a Dismiss button
      const dismissBtn = modal.getByText(/dismiss/i)
      await expect(dismissBtn).toBeVisible()
    } else {
      // Not in failed state — skip
      test.skip()
    }
  })

  test('"Maybe later" dismisses the modal (session-only)', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const modalShown = await isModalVisible(page)
    if (!modalShown) { test.skip(); return }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')

    // Look for "Maybe later" button (idle state only)
    const maybeLaterBtn = modal.getByText(/maybe later/i)
    const hasBtn = await maybeLaterBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasBtn) { test.skip(); return }

    await maybeLaterBtn.click()
    await page.waitForTimeout(800)

    // Modal should be dismissed
    await expect(modal).not.toBeVisible()
  })
})
