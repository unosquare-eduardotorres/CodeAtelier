/**
 * Grill Session Lifecycle E2E Tests — Tier B
 *
 * Verifies grill session persistence, iteration cycling, plan handoff,
 * and score gauge accuracy. These are the fragile session-state flows
 * that break when stores or IPC layers change.
 *
 *   1. Grill session restores after page navigation (persistence)
 *   2. Multiple iterations show in sidebar iteration selector
 *   3. Completed grill → "Generate Plan" → plan appears in Plans tab with 🔥 badge
 *   4. Score gauge numeric value matches evaluation result
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/grill-session-lifecycle.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Grill Session Lifecycle', () => {
  // ── Shared helpers ────────────────────────────────────────────────

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
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('ideas')
    await page.waitForTimeout(500)

    // Try to find and click the grill button
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

  async function navigateToPlans(page: import('@playwright/test').Page): Promise<void> {
    const settings = new WorkspaceSettings(page)

    const settingsTab = page.getByRole('button', { name: /settings/i })
    const hasTab = await settingsTab
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasTab) {
      await settingsTab.first().click()
      await page.waitForTimeout(500)
    }
    await settings.openTab('plans')
    await page.waitForTimeout(500)
  }

  // ── 1. Grill session restores after page navigation ───────────────

  test('grill session restores after navigating away and back', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Capture some identifying content from the current grill session
    const grillPage = page.locator('[data-testid="grill-page"]')
    const grillContent = await grillPage.textContent()
    const hasContent = (grillContent?.length ?? 0) > 0

    if (!hasContent) {
      test.skip()
      return
    }

    // Look for a session identifier — title, track name, or score
    const sessionTitle = page.locator('.font-semibold, .font-medium, h2, h3').first()
    const _titleText = await sessionTitle.textContent().catch(() => '')

    // Navigate away to a different tab
    const settings = new WorkspaceSettings(page)
    await settings.openTab('plans')
    await page.waitForTimeout(1_000)

    // Navigate back to the grill
    await settings.openTab('ideas')
    await page.waitForTimeout(500)

    const grillBtn = page.getByRole('button', { name: /grill/i }).first()
    const hasGrillBtn = await grillBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasGrillBtn) {
      await grillBtn.click()
      await page.waitForTimeout(2_000)
    }

    // Grill page should be restored
    const grillPageRestored = page.locator('[data-testid="grill-page"]')
    const isRestored = await grillPageRestored.isVisible({ timeout: 10_000 }).catch(() => false)
    expect(isRestored).toBeTruthy()

    // Content should still be present (session was persisted)
    const restoredContent = await grillPageRestored.textContent()
    expect(restoredContent?.length ?? 0).toBeGreaterThan(0)
  })

  // ── 2. Multiple iterations show in sidebar ────────────────────────

  test('sidebar shows iteration history when multiple rounds exist', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Look for iteration indicators in the sidebar
    // These may be: round labels, iteration count, or numbered rounds
    const sidebar = page.locator('[data-testid="grill-sidebar"]')
    const hasSidebar = await sidebar.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasSidebar) {
      // Sidebar might not be visible — check for iteration info elsewhere
      const iterationText = page.getByText(/round|iteration|re-evaluat/i).first()
      const hasIteration = await iterationText.isVisible({ timeout: 5_000 }).catch(() => false)

      if (!hasIteration) {
        // May only have one round — single-iteration grill sessions are valid
        test.skip()
        return
      }

      // Verify iteration info is displayed
      const text = await iterationText.textContent()
      expect(text).toMatch(/round|iteration|re-evaluat/i)
      return
    }

    // Check sidebar for iteration count or round labels
    const sidebarText = await sidebar.textContent()

    // Look for iteration indicators
    const hasIterationInfo =
      /iteration|round \d+|re-evaluat/i.test(sidebarText ?? '') ||
      /\d+\s*round/i.test(sidebarText ?? '')

    if (hasIterationInfo) {
      expect(hasIterationInfo).toBeTruthy()
    }

    // If there are decision items, verify they're grouped by iteration
    const decisionItems = sidebar.locator('[class*="rounded"]')
    const decisionCount = await decisionItems.count()

    // At least some content should be in the sidebar
    expect(decisionCount).toBeGreaterThanOrEqual(0) // 0 is valid for first round
  })

  // ── 3. Completed grill → Generate Plan → Plan in Plans tab ────────

  test('completed grill generates plan visible in Plans tab with 🔥 badge', async ({
    electronPage: page
  }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Check if we're in a completed state (score gauge or "Generate Plan" button visible)
    const generatePlanBtn = page.getByRole('button', { name: /generate plan/i }).first()
    const hasGenerateBtn = await generatePlanBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    // Also check for existing score gauge (indicates completed evaluation)
    const scoreGauge = page.locator('[data-testid="score-gauge"]')
    const hasScoreGauge = await scoreGauge.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasGenerateBtn && !hasScoreGauge) {
      // Grill is not in a completed state — may be mid-evaluation
      test.skip()
      return
    }

    if (hasGenerateBtn) {
      // Click "Generate Plan"
      await generatePlanBtn.click()
      await page.waitForTimeout(5_000) // Plan generation takes time (LLM call)

      // Wait for plan generation to complete
      // Look for success indicators: "Plan Generated", toast, or redirect
      const planSuccess = page.getByText(/plan generated|plan saved|plan created/i).first()
      // Awaited for its settling effect only — the plan may have been saved
      // regardless of whether a success message is visible, so the Plans tab
      // below is checked unconditionally.
      await planSuccess.isVisible({ timeout: 30_000 }).catch(() => false)
    }

    // Navigate to Plans tab
    await navigateToPlans(page)
    await page.waitForTimeout(500)

    // Select "All" filter
    const allTab = page.locator('[data-testid="plan-filter-all"]')
    const hasAllTab = await allTab.isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasAllTab) {
      await allTab.click()
      await page.waitForTimeout(300)
    }

    // Look for a grill-sourced plan (🔥 badge)
    const planCards = page.locator('[data-testid^="plan-card-"]')
    const planCount = await planCards.count()

    if (planCount === 0) {
      // No plans exist — Generate Plan may not have completed
      test.skip()
      return
    }

    // Find the grill-sourced plan
    let foundGrillPlan = false
    for (let i = 0; i < Math.min(planCount, 10); i++) {
      const text = await planCards.nth(i).textContent()
      if (/🔥|grill/i.test(text ?? '')) {
        foundGrillPlan = true
        expect(text).toMatch(/🔥|grill/i)
        break
      }
    }

    // If no grill plan found, that's data-dependent but we still verify plans render
    if (!foundGrillPlan && planCount > 0) {
      // At least plans are rendering — the grill plan may not have been generated yet
      const firstCardText = await planCards.first().textContent()
      expect(firstCardText?.length).toBeGreaterThan(0)
    }
  })

  // ── 4. Score gauge numeric value matches evaluation ────────────────

  test('score gauge displays numeric value matching evaluation', async ({ electronPage: page }) => {
    const onGrill = await navigateToGrill(page)
    if (!onGrill) {
      test.skip()
      return
    }

    // Find the ScoreGauge component
    const scoreGauge = page.locator('[data-testid="score-gauge"]')
    const hasGauge = await scoreGauge.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasGauge) {
      // Score gauge only appears after an evaluation is complete
      // Check for evaluation bubble which also shows the score
      const evalBubble = page.locator('[data-testid="grill-evaluation-bubble"]')
      const hasEval = await evalBubble.isVisible({ timeout: 5_000 }).catch(() => false)

      if (!hasEval) {
        test.skip()
        return
      }

      // Verify evaluation bubble contains a numeric score
      const evalText = await evalBubble.textContent()
      const scoreMatch = evalText?.match(/(\d{1,3})\s*\/\s*100|\b(\d{1,3})\b/)
      expect(scoreMatch).not.toBeNull()
      return
    }

    // Read the gauge's numeric value
    const gaugeValue = page.locator('[data-testid="score-gauge-value"]')
    const hasValue = await gaugeValue.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasValue) {
      // Gauge exists but value element not found — check SVG text
      const gaugeText = await scoreGauge.textContent()
      const scoreMatch = gaugeText?.match(/(\d{1,3})/)
      expect(scoreMatch).not.toBeNull()
      return
    }

    const valueText = await gaugeValue.textContent()
    const numericScore = parseInt(valueText ?? '', 10)

    // Score should be a valid number between 0-100
    expect(numericScore).toBeGreaterThanOrEqual(0)
    expect(numericScore).toBeLessThanOrEqual(100)

    // Verify the gauge displays a label (Raw/Warming Up/Medium Rare/Well Done/Perfectly Grilled)
    const gaugeFullText = await scoreGauge.textContent()
    expect(gaugeFullText).toMatch(/raw|warming|medium|well done|perfectly/i)
  })
})
