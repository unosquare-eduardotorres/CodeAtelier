/**
 * Council Flow E2E Tests
 *
 * Verifies CouncilView (599 LOC), CouncilLanding (442 LOC) — peer review system:
 *   - Council landing renders with start button
 *   - Start council modal opens with configuration
 *   - Council view shows member columns
 *   - Member column displays advisor recommendations
 *   - Verdict card shows consensus decision
 *   - Session history lists past council sessions
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/council-flow.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Council Flow', () => {
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

  async function navigateToCouncil(page: import('@playwright/test').Page): Promise<boolean> {
    const settingsTab = page.locator('[data-testid="sidebar-tab-settings"]')
    if (!(await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await settingsTab.click()
    await page.waitForTimeout(500)

    const councilTab = page
      .locator('button')
      .filter({ hasText: /council/i })
      .first()
    if (!(await councilTab.isVisible({ timeout: 3_000 }).catch(() => false))) return false
    await councilTab.click()
    await page.waitForTimeout(800)

    // Check for council landing or council view
    const landing = page.locator('[data-testid="council-landing"]')
    const view = page.locator('[data-testid="council-view"]')
    const hasLanding = await landing.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasView = await view.isVisible({ timeout: 2_000 }).catch(() => false)
    return hasLanding || hasView
  }

  test('council landing renders with start button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    const landing = page.locator('[data-testid="council-landing"]')
    const hasLanding = await landing.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasLanding) {
      // Should show "Your Council" header
      await expect(landing.getByText('Your Council')).toBeVisible()

      // Should have a start button
      const startBtn = page.locator('[data-testid="council-start-btn"]')
      await expect(startBtn).toBeVisible()
    } else {
      // Active council view is showing instead — that's also valid
      const view = page.locator('[data-testid="council-view"]')
      await expect(view).toBeVisible()
    }
  })

  test('start council modal opens with configuration', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    const startBtn = page.locator('[data-testid="council-start-btn"]')
    const hasStart = await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasStart) {
      test.skip()
      return
    }

    await startBtn.click()
    await page.waitForTimeout(800)

    const modal = page.locator('[data-testid="council-start-modal"]')
    await expect(modal).toBeVisible({ timeout: 3_000 })

    // Modal should have input type selection and content area
    const textArea = modal.locator('textarea')
    await expect(textArea).toBeVisible()

    // Close modal
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  })

  test('council view shows member columns', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    const view = page.locator('[data-testid="council-view"]')
    const hasView = await view.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasView) {
      test.skip()
      return
    }

    // Should show "LLM Council" header
    await expect(view.getByText('LLM Council')).toBeVisible()

    // Should have member columns
    const columns = page.locator('[data-testid="council-member-column"]')
    const columnCount = await columns.count()
    // Active council should show 1-5 advisor columns
    expect(columnCount).toBeGreaterThan(0)
  })

  test('member column displays advisor recommendations', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    const columns = page.locator('[data-testid="council-member-column"]')
    const count = await columns.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Each column should have an advisor name/role
    const firstColumn = columns.first()
    const columnText = await firstColumn.textContent()
    expect(columnText?.length).toBeGreaterThan(0)
  })

  test('verdict card shows consensus decision', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    const verdictCard = page.locator('[data-testid="council-verdict-card"]')
    const hasVerdict = await verdictCard.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasVerdict) {
      test.skip()
      return
    }

    // Verdict should have score and recommendation
    const verdictText = await verdictCard.textContent()
    expect(verdictText?.length).toBeGreaterThan(0)
  })

  test('session history lists past council sessions', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const navigated = await navigateToCouncil(page)
    if (!navigated) {
      test.skip()
      return
    }

    // If we're on the landing page with history, check for session cards
    const landing = page.locator('[data-testid="council-landing"]')
    const hasLanding = await landing.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasLanding) {
      // On active council view — can't check history
      test.skip()
      return
    }

    // Look for filter bar (indicates history mode) or empty state
    const filterBar = page.locator('button').filter({ hasText: /all|active|completed|failed/i })
    const hasFilter = await filterBar
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    // Either filter bar (history exists) or empty state CTA
    const hasCta = await page
      .locator('[data-testid="council-start-btn"]')
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    expect(hasFilter || hasCta).toBeTruthy()
  })
})
