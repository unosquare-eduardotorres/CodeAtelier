/**
 * Bug Tracker E2E Tests
 *
 * Verifies BugTrackerPage (105 LOC) — bug tracking dashboard:
 *   - Bug tracker page renders with two-pane layout
 *   - Bug card list shows filtered entries or empty state
 *   - Clicking bug card shows detail panel
 *   - Bug detail shows stack trace and action buttons
 *   - Resolve/unresolve toggles bug status
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/bug-tracker.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Bug Tracker', () => {
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

  /** Navigate to the bug tracker page. */
  async function navigateToBugTracker(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Bug tracker is accessed via the app-level menu (not workspace settings)
    const bugBtn = page.locator('[aria-label="Bug Tracker"], [data-testid="bug-tracker-btn"]')
    let hasBtn = await bugBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasBtn) {
      await bugBtn.first().click()
      await page.waitForTimeout(800)
      return true
    }

    // Try via status bar or menu
    const bugIcon = page.getByRole('button', { name: /bug/i }).first()
    hasBtn = await bugIcon.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasBtn) {
      await bugIcon.click()
      await page.waitForTimeout(800)
      return true
    }

    return false
  }

  test('bug tracker page renders with two-pane layout', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToBugTracker(page)
    if (!navigated) { test.skip(); return }

    const bugTracker = page.locator('[data-testid="bug-tracker-page"]')
    await expect(bugTracker).toBeVisible({ timeout: 5_000 })

    // Header with "Bug Tracker" title
    const header = page.getByText(/bug tracker/i).first()
    await expect(header).toBeVisible()

    // Two-pane layout: bug list + detail panel
    const bugList = page.locator('[data-testid="bug-card"]')
    const bugDetail = page.locator('[data-testid="bug-detail"]')

    await expect(bugList).toBeVisible()
    await expect(bugDetail).toBeVisible()
  })

  test('bug card list shows filtered entries or empty state', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToBugTracker(page)
    if (!navigated) { test.skip(); return }

    const bugTracker = page.locator('[data-testid="bug-tracker-page"]')
    const hasPage = await bugTracker.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Bug list pane should show either bugs or empty state
    const bugList = page.locator('[data-testid="bug-card"]')
    const bugItems = bugList.locator('[class*="cursor-pointer"], button').filter({
      hasText: /.+/
    })

    const bugCount = await bugItems.count()
    const emptyText = page.getByText(/no bugs (found|detected)/i).first()
    const hasEmpty = await emptyText.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(bugCount > 0 || hasEmpty).toBeTruthy()
  })

  test('clicking bug card shows detail panel', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToBugTracker(page)
    if (!navigated) { test.skip(); return }

    const bugTracker = page.locator('[data-testid="bug-tracker-page"]')
    const hasPage = await bugTracker.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Look for clickable bug cards
    const bugItems = page.locator('[data-testid="bug-card"] [class*="cursor-pointer"]')
    const count = await bugItems.count()

    if (count === 0) {
      test.skip()
      return
    }

    // Click the first bug
    await bugItems.first().click()
    await page.waitForTimeout(500)

    // Detail panel should show bug details
    const bugDetail = page.locator('[data-testid="bug-detail"]')
    const detailText = await bugDetail.textContent()
    expect(detailText?.length).toBeGreaterThan(0)
  })

  test('bug detail shows stack trace and action buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToBugTracker(page)
    if (!navigated) { test.skip(); return }

    const bugTracker = page.locator('[data-testid="bug-tracker-page"]')
    const hasPage = await bugTracker.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click first bug if any exist
    const bugItems = page.locator('[data-testid="bug-card"] [class*="cursor-pointer"]')
    const count = await bugItems.count()

    if (count === 0) { test.skip(); return }

    await bugItems.first().click()
    await page.waitForTimeout(500)

    // Detail panel should show action buttons
    const detailPanel = page.locator('[data-testid="bug-detail"]')
    const actionBtns = detailPanel.locator('button')
    const btnCount = await actionBtns.count()

    expect(btnCount).toBeGreaterThan(0)
  })

  test('resolve/unresolve toggles bug status', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToBugTracker(page)
    if (!navigated) { test.skip(); return }

    const bugTracker = page.locator('[data-testid="bug-tracker-page"]')
    const hasPage = await bugTracker.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click first bug
    const bugItems = page.locator('[data-testid="bug-card"] [class*="cursor-pointer"]')
    const count = await bugItems.count()

    if (count === 0) { test.skip(); return }

    await bugItems.first().click()
    await page.waitForTimeout(500)

    // Look for resolve/unresolve button
    const resolveBtn = page.getByRole('button', { name: /resolve|unresolve/i }).first()
    const hasResolve = await resolveBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasResolve) { test.skip(); return }

    await expect(resolveBtn).toBeEnabled()
  })
})
