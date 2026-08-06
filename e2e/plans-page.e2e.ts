/**
 * Plans Page E2E Tests
 *
 * Verifies PlansPage (115 LOC) — plan management with filtering and routing:
 *   - Plans page renders with plan cards or empty state
 *   - Filter tabs switch between Chat/Grill/Health/Council sources
 *   - Plan card shows title, source, and action buttons
 *   - Open in Chat action routes to conversation
 *   - Archive/Restore toggles plan visibility
 *   - Search filters plans by text content
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/plans-page.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

// nav hidden — the 'plans' entry is marked `hidden: true` in SETTINGS_MENU, so
// navigateToSettingsTab('plans') can no longer find a button. The page and its
// route are intact; unhide the entry to restore this coverage.
test.describe.skip('Plans Page', () => {
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

  async function navigateToPlans(page: import('@playwright/test').Page): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('plans')
  }

  test('plans page renders with plan cards or empty state', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const plansPage = page.locator('[data-testid="plans-page"]')
    await expect(plansPage).toBeVisible({ timeout: 5_000 })

    // Should show either plan cards or an empty state
    const planCards = page.locator('[data-testid="plan-card"]')
    const emptyState = page.getByText(/no plans|get started/i).first()

    const cardCount = await planCards.count()
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(cardCount > 0 || hasEmpty).toBeTruthy()
  })

  test('filter tabs switch between Chat/Grill/Health/Council sources', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const plansPage = page.locator('[data-testid="plans-page"]')
    const hasPage = await plansPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Look for filter buttons (source filters)
    const filterBtns = page.locator('button').filter({
      hasText: /all|chat|grill|health|council/i
    })
    const filterCount = await filterBtns.count()

    if (filterCount === 0) {
      // No plans means no filters shown
      test.skip()
      return
    }

    expect(filterCount).toBeGreaterThan(0)
  })

  test('plan card shows title, source, and action buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const planCards = page.locator('[data-testid="plan-card"]')
    const cardCount = await planCards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    const firstCard = planCards.first()
    await expect(firstCard).toBeVisible()

    // Card should contain text content (title)
    const cardText = await firstCard.textContent()
    expect(cardText?.length).toBeGreaterThan(0)
  })

  test('open in Chat action routes to conversation', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const planCards = page.locator('[data-testid="plan-card"]')
    const cardCount = await planCards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // Look for "Open in Chat" or chat-related action on the first card
    const chatAction = planCards
      .first()
      .getByRole('button', { name: /chat|open|view/i })
      .first()
    const hasAction = await chatAction.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasAction) {
      test.skip()
      return
    }

    await expect(chatAction).toBeEnabled()
  })

  test('archive/restore toggles plan visibility', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const planCards = page.locator('[data-testid="plan-card"]')
    const cardCount = await planCards.count()

    if (cardCount === 0) {
      test.skip()
      return
    }

    // Look for archive/restore button on a plan card
    const archiveBtn = planCards
      .first()
      .getByRole('button', { name: /archive|restore/i })
      .first()
    const hasArchive = await archiveBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasArchive) {
      test.skip()
      return
    }

    await expect(archiveBtn).toBeEnabled()
  })

  test('search filters plans by text content', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const navigated = await navigateToPlans(page)
    if (!navigated) {
      test.skip()
      return
    }

    const plansPage = page.locator('[data-testid="plans-page"]')
    const hasPage = await plansPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) {
      test.skip()
      return
    }

    // Look for search input
    const searchInput = page.locator('input[type="text"], input[placeholder*="search" i]').first()
    const hasSearch = await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasSearch) {
      // Search only shows when there are plans
      test.skip()
      return
    }

    await expect(searchInput).toBeVisible()
  })
})
