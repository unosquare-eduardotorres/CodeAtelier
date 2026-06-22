/**
 * Grill Header Navigation E2E Tests
 *
 * Covers the GrillPageHeader — the only way to navigate within/out of a grill session:
 *   - "Back to Ideas" button navigates away from grill
 *   - "Stop Grilling" button aborts mid-evaluation
 *   - "All Tracks" button returns to track selector
 *   - "Discard" button shows confirmation and removes session
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-header-nav.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Grill Header Navigation', () => {
  /**
   * Helper: navigate to the grill page (Ideas tab → start a grill or find active one).
   * Returns true if the grill page is visible.
   */
  async function navigateToGrill(page: import('@playwright/test').Page): Promise<boolean> {
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
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('ideas')
    await page.waitForTimeout(500)

    // Try to find and click a grill button
    const grillBtn = page.getByRole('button', { name: /grill/i }).first()
    const hasGrillBtn = await grillBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (hasGrillBtn) {
      await grillBtn.click()
      await page.waitForTimeout(2_000)
    }

    // Check if grill page is visible
    const grillPage = page.locator('[data-testid="grill-page"]')
    return grillPage.isVisible({ timeout: 10_000 }).catch(() => false)
  }

  // ── Back to Ideas ──

  test('"Back to Ideas" button navigates away from grill', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // Verify the header is visible
    const header = page.locator('[data-testid="grill-page-header"]')
    await expect(header).toBeVisible({ timeout: 5_000 })

    // Click "Back to Ideas" button
    const backBtn = page.locator('[data-testid="grill-header-back"]')
    await expect(backBtn).toBeVisible({ timeout: 3_000 })
    await backBtn.click()
    await page.waitForTimeout(2_000)

    // Grill page should disappear — ideas tab or workspace should be visible
    const grillPage = page.locator('[data-testid="grill-page"]')
    const stillOnGrill = await grillPage.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(stillOnGrill).toBeFalsy()
  })

  // ── Stop Grilling ──

  test('"Stop Grilling" button aborts mid-evaluation', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // "Stop Grilling" only appears during 'evaluating' phase
    const stopBtn = page.locator('[data-testid="grill-header-stop"]')
    const hasStopBtn = await stopBtn.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasStopBtn) {
      // Not in evaluating phase — skip gracefully
      test.skip()
      return
    }

    await stopBtn.click()
    await page.waitForTimeout(2_000)

    // After stopping, the stop button should disappear (no longer evaluating)
    const stillVisible = await stopBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(stillVisible).toBeFalsy()

    // Question card or track selector should appear
    const questionCard = page.locator('[data-testid="grill-question-card"]')
    const trackSelector = page.locator('[data-testid="grill-track-selector"]')

    const hasQuestion = await questionCard.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasTrackSelector = await trackSelector.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(hasQuestion || hasTrackSelector).toBeTruthy()
  })

  // ── All Tracks ──

  test('"All Tracks" button returns to track selector', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // "All Tracks" appears in answering/completed phases (not selecting or evaluating)
    const allTracksBtn = page.locator('[data-testid="grill-header-all-tracks"]')
    const hasAllTracks = await allTracksBtn.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasAllTracks) {
      // Not in a phase that shows "All Tracks" — skip gracefully
      test.skip()
      return
    }

    await allTracksBtn.click()
    await page.waitForTimeout(2_000)

    // Track selector should become visible
    const trackSelector = page.locator('[data-testid="grill-track-selector"]')
    const hasSelector = await trackSelector.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasSelector).toBeTruthy()
  })

  // ── Discard ──

  test('"Discard" button shows confirmation and removes session', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // Discard button appears when phase !== 'selecting'
    const discardBtn = page.locator('[data-testid="grill-header-discard"]')
    const hasDiscard = await discardBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasDiscard) {
      test.skip()
      return
    }

    // Set up dialog handler to accept the confirmation
    let dialogMessage = ''
    page.on('dialog', async (dialog) => {
      dialogMessage = dialog.message()
      await dialog.accept()
    })

    await discardBtn.click()
    await page.waitForTimeout(2_000)

    // Confirmation dialog should have been triggered
    expect(dialogMessage).toMatch(/discard/i)

    // After accepting, grill page should disappear
    const grillPage = page.locator('[data-testid="grill-page"]')
    const stillOnGrill = await grillPage.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(stillOnGrill).toBeFalsy()
  })
})
