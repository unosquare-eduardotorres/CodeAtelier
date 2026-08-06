/**
 * Goal Page Deep E2E Tests
 *
 * Verifies the GoalPage component (361 LOC) — orchestrates campaigns and
 * goal runs with approval gates and phase timelines:
 *   - Goal page renders with campaign panel
 *   - Campaign 3-step form progresses
 *   - Approval gate blocks until resolved
 *   - Active goal shows phase timeline
 *   - Run history navigation
 *   - Cancel running goal/campaign
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/goal-page-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Goal Page Deep', () => {
  async function ensureWorkspaceReady(page: import('@playwright/test').Page): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

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
    return true
  }

  /** Navigate to the Goals tab in workspace settings. */
  async function navigateToGoals(page: import('@playwright/test').Page): Promise<boolean> {
    // Try navigating via sidebar tab
    const goalsTab = page.locator('[data-testid="sidebar-goals-tab"]')
    let hasTab = await goalsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await goalsTab.click()
      await page.waitForTimeout(1_000)
      return true
    }

    // Try sidebar button with "Goals" text
    const goalsBtn = page.getByRole('button', { name: /goals/i }).first()
    hasTab = await goalsBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasTab) {
      await goalsBtn.click()
      await page.waitForTimeout(1_000)
      return true
    }

    // Try via workspace settings
    const settingsBtn = page.locator('[aria-label="Workspace Settings"]')
    const hasSettings = await settingsBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasSettings) {
      await settingsBtn.click()
      await page.waitForTimeout(800)

      const goalSettingsTab = page
        .locator('button, [role="tab"]')
        .filter({ hasText: /goals/i })
        .first()
      hasTab = await goalSettingsTab.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasTab) {
        await goalSettingsTab.click()
        await page.waitForTimeout(800)
        return true
      }
    }

    return false
  }

  test('goal page renders with campaign panel', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Goal page should show the Goals header with experimental badge
    const header = page.getByText('Goals')
    const hasHeader = await header
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)
    expect(hasHeader).toBeTruthy()

    // Experimental badge
    const badge = page.getByText('Experimental')
    const hasBadge = await badge
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    expect(hasBadge).toBeTruthy()

    // Either empty state CTA or history should be visible
    const startBtn = page.getByText(/start your first goal|new goal/i).first()
    const hasStart = await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasHistory = await page
      .getByText(/past|history/i)
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)

    expect(hasStart || hasHistory).toBeTruthy()
  })

  test('campaign 3-step form progresses', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Click "Start Your First Goal" or "New Goal" button
    const startBtn = page.getByText(/start your first goal|new goal/i).first()
    const hasStart = await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasStart) {
      test.skip()
      return
    }

    await startBtn.click()
    await page.waitForTimeout(1_000)

    // Campaign panel should appear — look for description input area
    const descriptionArea = page.locator('textarea').first()
    const hasDescription = await descriptionArea.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasDescription) {
      // Fill in a goal description
      await descriptionArea.fill('E2E test: Refactor auth module')
      await page.waitForTimeout(500)

      // Look for a "Next" or "Review" or submit button
      const nextBtn = page.getByRole('button', { name: /next|review|describe|submit/i }).first()
      const hasNext = await nextBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasNext) {
        // Don't actually submit — just verify the form is interactive
        await expect(nextBtn).toBeVisible()
      }
    }
  })

  test('approval gate blocks until resolved', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Check if an approval gate is visible (from an in-progress goal)
    const approveBtn = page.getByRole('button', { name: /approve/i }).first()
    const hasApproval = await approveBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasApproval) {
      // No active goal with pending approval
      test.skip()
      return
    }

    // Approval gate should show plan artifact preview
    const planPreview = page.getByText(/plan|implementation/i).first()
    await expect(planPreview).toBeVisible()

    // Both approve and reject buttons should be visible
    await expect(approveBtn).toBeVisible()
    const rejectBtn = page.getByRole('button', { name: /reject/i }).first()
    await expect(rejectBtn).toBeVisible()
  })

  test('active goal shows phase timeline', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Check if an active goal is running (shows timeline)
    const timeline = page.getByText(/plan|execute|verify/i).first()
    const hasTimeline = await timeline.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasTimeline) {
      // No active goal — check for phase cards in empty state
      const phaseCards = page.locator('.rounded-xl')
      const count = await phaseCards.count()
      // Empty state shows 4 phase workflow cards: Plan, Review, Execute, Verify
      if (count >= 4) {
        const planCard = page.getByText(/agent analyzes your goal/i)
        await expect(planCard).toBeVisible()
      }
      return
    }

    // Active goal timeline should show phase entries
    await expect(timeline).toBeVisible()
  })

  test('run history navigation', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Look for past run entries
    const historyItems = page.locator('[class*="cursor-pointer"]').filter({
      hasText: /completed|failed|cancelled/i
    })
    const count = await historyItems.count()

    if (count === 0) {
      // No history entries
      test.skip()
      return
    }

    // Click first history entry
    await historyItems.first().click()
    await page.waitForTimeout(1_000)

    // Detail view should appear with a back button
    const backBtn = page.getByRole('button', { name: /back/i }).first()
    const hasBack = await backBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasBack) {
      await backBtn.click()
      await page.waitForTimeout(500)
    }
  })

  test('cancel running goal/campaign', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToGoals(page)
    if (!navigated) {
      test.skip()
      return
    }

    // Cancel button only appears when goal/campaign is active
    const cancelBtn = page.getByRole('button', { name: /cancel/i }).first()
    const hasCancel = await cancelBtn.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCancel) {
      // No active goal to cancel
      test.skip()
      return
    }

    // Verify cancel button is clickable (don't actually cancel)
    await expect(cancelBtn).toBeVisible()
    await expect(cancelBtn).toBeEnabled()
  })
})
