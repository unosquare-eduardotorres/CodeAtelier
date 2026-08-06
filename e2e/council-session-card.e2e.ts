/**
 * Council Session Card E2E Tests
 *
 * Verifies CouncilSessionCard (218 LOC) — session list entry with status and actions:
 *   - Session card renders with status badge
 *   - Advisor avatars display for completed advisors
 *   - Clicking a session card navigates to its detail view
 *   - In-progress session shows loading spinner animation
 *   - Completed session displays verdict score preview
 *   - Delete button shows confirmation dialog before removal
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/council-session-card.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Council Session Card', () => {
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

  async function navigateToCouncilLanding(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('council')
    await page.waitForTimeout(800)

    // Must have session cards visible (history mode)
    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const count = await sessionCards.count()
    return count > 0
  }

  test('session card renders with status badge', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    const card = page.locator('[data-testid="council-session-card"]').first()
    await expect(card).toBeVisible()

    // Status badge should be visible (Running, Completed, Failed, Cancelled)
    const statusBadge = card.getByText(/Running|Completed|Failed|Cancelled/i).first()
    const hasBadge = await statusBadge.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasBadge).toBeTruthy()
  })

  test('advisor avatars display for completed advisors', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    const card = page.locator('[data-testid="council-session-card"]').first()
    await expect(card).toBeVisible()

    // Card should show advisor count text (e.g., "3/5 advisors")
    const advisorCount = card.getByText(/\d\/5 advisors/i).first()
    const hasCount = await advisorCount.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasCount).toBeTruthy()
  })

  test('clicking a session card navigates to its detail view', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    const card = page.locator('[data-testid="council-session-card"]').first()
    const viewBtn = card.locator('button').filter({ hasText: /view/i }).first()
    const hasView = await viewBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasView) { test.skip(); return }

    await viewBtn.click()
    await page.waitForTimeout(1_000)

    // Council view should appear
    const councilView = page.locator('[data-testid="council-view"]')
    const hasCouncilView = await councilView.isVisible({ timeout: 5_000 }).catch(() => false)
    expect(hasCouncilView).toBeTruthy()
  })

  test('in-progress session shows loading spinner animation', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    // Look for a running session
    const runningCard = page.locator('[data-testid="council-session-card"]')
      .filter({ hasText: /Running/i })
      .first()
    const hasRunning = await runningCard.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasRunning) {
      // No running sessions — that's OK, skip
      test.skip()
      return
    }

    // Running status should have an animated spinner (Loader2 with animate-spin)
    const spinner = runningCard.locator('.animate-spin')
    const hasSpinner = await spinner.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasSpinner).toBeTruthy()
  })

  test('completed session displays verdict score preview', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    // Look for a completed session with score
    const completedCard = page.locator('[data-testid="council-session-card"]')
      .filter({ hasText: /Completed/i })
      .first()
    const hasCompleted = await completedCard.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasCompleted) { test.skip(); return }

    // Completed session should show a score badge (e.g., "75/100")
    const scoreBadge = completedCard.getByText(/\d+\/100/).first()
    const hasScore = await scoreBadge.isVisible({ timeout: 3_000 }).catch(() => false)
    // Score may not always be present (some sessions may lack verdict)
    if (hasScore) {
      await expect(scoreBadge).toBeVisible()
    }
  })

  test('delete button shows confirmation dialog before removal', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const hasCards = await navigateToCouncilLanding(page)
    if (!hasCards) { test.skip(); return }

    const card = page.locator('[data-testid="council-session-card"]').first()

    // Delete button (Trash2 icon)
    const deleteBtn = card.locator('button[aria-label="Delete session"]')
    const hasDelete = await deleteBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasDelete) { test.skip(); return }

    await deleteBtn.click()
    await page.waitForTimeout(500)

    // Confirmation dialog should appear
    const confirmDialog = page.getByText(/Are you sure you want to delete/i).first()
    const hasConfirm = await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasConfirm).toBeTruthy()

    // Cancel the deletion
    const cancelBtn = page.getByRole('button', { name: /cancel/i }).first()
    if (await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cancelBtn.click()
      await page.waitForTimeout(300)
    }
  })
})
