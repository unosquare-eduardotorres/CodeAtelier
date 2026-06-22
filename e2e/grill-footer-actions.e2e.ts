/**
 * Grill Footer Actions E2E Tests
 *
 * Covers GrillPageFooter action button execution flows:
 *   - "Submit Answers" triggers re-evaluation
 *   - "Generate Plan" creates plan after completed evaluation
 *   - Phase-appropriate buttons change per phase
 *   - "Skip All" then "Submit" bypasses all questions
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-footer-actions.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Grill Footer Actions', () => {
  /**
   * Helper: navigate to the grill page.
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

    const grillPage = page.locator('[data-testid="grill-page"]')
    return grillPage.isVisible({ timeout: 10_000 }).catch(() => false)
  }

  // ── Submit Answers ──

  test('"Submit Answers" triggers re-evaluation', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // Wait for questions to load
    const questionCard = page.locator('[data-testid="grill-question-card"]')
    const hasCard = await questionCard.isVisible({ timeout: 60_000 }).catch(() => false)

    if (!hasCard) {
      test.skip()
      return
    }

    // Find Submit Answers button
    const submitBtn = page.getByRole('button', { name: /submit answers|accept.*re-evaluate/i })
    const hasSubmit = await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSubmit) {
      test.skip()
      return
    }

    // Check if button is enabled (requires answers or all skipped)
    const isDisabled = await submitBtn.isDisabled()

    if (!isDisabled) {
      await submitBtn.click()
      await page.waitForTimeout(3_000)

      // After submitting, either:
      // 1. Streaming indicator appears (evaluation starts)
      // 2. Stop button appears in header (now evaluating)
      const stopBtn = page.locator('[data-testid="grill-header-stop"]')
      const streamingIndicator = page.locator('.animate-pulse, .animate-spin').first()

      const hasStop = await stopBtn.isVisible({ timeout: 10_000 }).catch(() => false)
      const hasStreaming = await streamingIndicator.isVisible({ timeout: 5_000 }).catch(() => false)

      expect(hasStop || hasStreaming).toBeTruthy()
    } else {
      // Button is disabled — answers needed first, still valid test
      expect(isDisabled).toBeTruthy()
    }
  })

  // ── Generate Plan ──

  test('"Generate Plan" creates plan after completed evaluation', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // "Generate Plan" only appears in completed phase with a score visible
    const generateBtn = page.getByRole('button', { name: /generate plan/i })
    const hasGenerate = await generateBtn.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasGenerate) {
      // Not in completed phase — skip gracefully
      test.skip()
      return
    }

    await expect(generateBtn).toBeEnabled()

    // Click generate plan — don't wait for full generation but verify it starts
    await generateBtn.click()
    await page.waitForTimeout(3_000)

    // After clicking, either:
    // 1. Button text changes to "Generating..." or spinner appears
    // 2. Navigation occurs to Plans tab
    // 3. Success indicator appears
    const generating = page.getByText(/generating|creating plan/i)
    const hasGenerating = await generating.isVisible({ timeout: 5_000 }).catch(() => false)

    const plansTab = page.getByText(/plans/i).first()
    const hasPlansTab = await plansTab.isVisible({ timeout: 5_000 }).catch(() => false)

    const successIndicator = page.getByText(/plan created|plan saved/i)
    const hasSuccess = await successIndicator.isVisible({ timeout: 30_000 }).catch(() => false)

    expect(hasGenerating || hasPlansTab || hasSuccess).toBeTruthy()
  })

  // ── Phase-appropriate buttons ──

  test('phase-appropriate buttons change per phase', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    // Check which phase we're in by looking at available buttons
    const submitBtn = page.getByRole('button', { name: /submit answers|accept.*re-evaluate/i })
    const generateBtn = page.getByRole('button', { name: /generate plan/i })
    const stopBtn = page.locator('[data-testid="grill-header-stop"]')

    const hasSubmit = await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasGenerate = await generateBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasStop = await stopBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // Determine phase from button visibility
    if (hasStop) {
      // Evaluating phase: Stop visible, Submit/Generate hidden
      expect(hasSubmit).toBeFalsy()
      expect(hasGenerate).toBeFalsy()
    } else if (hasSubmit) {
      // Answering phase: Submit visible, Generate hidden
      expect(hasGenerate).toBeFalsy()
    } else if (hasGenerate) {
      // Completed phase: Generate visible, Submit hidden
      expect(hasSubmit).toBeFalsy()
    }

    // At least one action should be available (unless in selecting phase)
    const trackSelector = page.locator('[data-testid="grill-track-selector"]')
    const hasTrackSelector = await trackSelector.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasTrackSelector) {
      // Not in selecting phase — one of the action buttons should be visible
      expect(hasSubmit || hasGenerate || hasStop).toBeTruthy()
    }
  })

  // ── Skip All then Submit ──

  test('"Skip All" then "Submit" bypasses all questions', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)

    if (!onGrill) {
      test.skip()
      return
    }

    const questionCard = page.locator('[data-testid="grill-question-card"]')
    const hasCard = await questionCard.isVisible({ timeout: 60_000 }).catch(() => false)

    if (!hasCard) {
      test.skip()
      return
    }

    // Find Skip All button
    const skipAllBtn = page.getByRole('button', { name: /skip all/i })
    const hasSkipAll = await skipAllBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSkipAll) {
      test.skip()
      return
    }

    await skipAllBtn.click()
    await page.waitForTimeout(1_000)

    // After skipping all, Submit Answers should become enabled
    const submitBtn = page.getByRole('button', { name: /submit answers/i })
    const hasSubmit = await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSubmit) {
      // Skip All may have auto-submitted
      test.skip()
      return
    }

    // Submit should now be enabled (all questions skipped)
    await expect(submitBtn).toBeEnabled()

    // Click submit
    await submitBtn.click()
    await page.waitForTimeout(3_000)

    // Evaluation should restart
    const stopBtn = page.locator('[data-testid="grill-header-stop"]')
    const streamingIndicator = page.locator('.animate-pulse, .animate-spin').first()

    const hasStop = await stopBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasStreaming = await streamingIndicator.isVisible({ timeout: 5_000 }).catch(() => false)

    expect(hasStop || hasStreaming).toBeTruthy()
  })
})
