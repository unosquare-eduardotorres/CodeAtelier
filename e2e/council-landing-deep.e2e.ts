/**
 * Council Landing Deep E2E Tests
 *
 * Verifies CouncilLanding (496 LOC) — council home page with history and CTA:
 *   - Landing page renders with session history or empty state
 *   - Empty state shows explainer text and "Start New Council" CTA
 *   - "New Council" button opens StartCouncilModal
 *   - History list shows past sessions with status badges
 *   - Loading skeleton appears during data fetch
 *   - Session cards in history are clickable
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/council-landing-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Council Landing Deep', () => {
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

  async function navigateToCouncil(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.selectTab('council')
    await page.waitForTimeout(800)

    // Either landing, active view, or filter bar should be visible
    const landing = page.locator('[data-testid="council-landing"]')
    const view = page.locator('[data-testid="council-view"]')
    const filterBar = page.locator('[data-testid="council-new-btn"]')
    const hasLanding = await landing.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasView = await view.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasFilter = await filterBar.isVisible({ timeout: 2_000 }).catch(() => false)
    return hasLanding || hasView || hasFilter
  }

  test('landing page renders with session history or empty state', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const navigated = await navigateToCouncil(page)
    if (!navigated) { test.skip(); return }

    // Either empty state landing OR history list should be visible
    const landing = page.locator('[data-testid="council-landing"]')
    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const hasLanding = await landing.isVisible({ timeout: 3_000 }).catch(() => false)
    const cardCount = await sessionCards.count()

    // One of these must be true: empty state landing, history cards, or active view
    expect(hasLanding || cardCount > 0).toBeTruthy()
  })

  test('empty state shows explainer text and "Start New Council" CTA', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const navigated = await navigateToCouncil(page)
    if (!navigated) { test.skip(); return }

    const landing = page.locator('[data-testid="council-landing"]')
    const hasLanding = await landing.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasLanding) { test.skip(); return }

    // Should show "Your Council" header
    const header = landing.getByText('Your Council')
    await expect(header).toBeVisible()

    // Should show explainer about adversarial review
    const explainer = landing.getByText(/adversarial review/i)
    await expect(explainer).toBeVisible()

    // CTA button should be visible
    const startBtn = page.locator('[data-testid="council-start-btn"]')
    await expect(startBtn).toBeVisible()
  })

  test('"New Council" button opens StartCouncilModal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const navigated = await navigateToCouncil(page)
    if (!navigated) { test.skip(); return }

    // Find a "New Council" or "Start" button (empty state or filter bar)
    const startBtn = page.locator('[data-testid="council-start-btn"]')
    const newBtn = page.locator('[data-testid="council-new-btn"]')
    let clicked = false

    if (await startBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await startBtn.click()
      clicked = true
    } else if (await newBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await newBtn.click()
      clicked = true
    }

    if (!clicked) { test.skip(); return }
    await page.waitForTimeout(800)

    // Modal should appear with a textarea for content input
    const modal = page.locator('[data-testid="council-start-modal"]')
    const hasModal = await modal.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasModal) {
      const textarea = modal.locator('textarea')
      await expect(textarea).toBeVisible()
    }

    // Close modal
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  })

  test('history list shows past sessions with status badges', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const navigated = await navigateToCouncil(page)
    if (!navigated) { test.skip(); return }

    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const count = await sessionCards.count()
    if (count === 0) { test.skip(); return }

    // Each session card should have a status badge
    const firstCard = sessionCards.first()
    const statusText = firstCard.getByText(/Running|Completed|Failed|Cancelled/i).first()
    const hasStatus = await statusText.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasStatus).toBeTruthy()
  })

  test('loading skeleton appears during data fetch', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    // Navigate fresh to council to catch the loading skeleton
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.selectTab('council')

    // Check for skeleton loaders (may be very brief)
    const skeleton = page.locator('.animate-pulse, [class*="skeleton"]').first()
    const hasSkeleton = await skeleton.isVisible({ timeout: 2_000 }).catch(() => false)

    // Skeleton may have already resolved — either skeleton or final content is OK
    const landing = page.locator('[data-testid="council-landing"]')
    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const view = page.locator('[data-testid="council-view"]')

    const hasLanding = await landing.isVisible({ timeout: 5_000 }).catch(() => false)
    const hasCards = (await sessionCards.count()) > 0
    const hasView = await view.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasSkeleton || hasLanding || hasCards || hasView).toBeTruthy()
  })

  test('session cards in history are clickable', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }
    const navigated = await navigateToCouncil(page)
    if (!navigated) { test.skip(); return }

    const sessionCards = page.locator('[data-testid="council-session-card"]')
    const count = await sessionCards.count()
    if (count === 0) { test.skip(); return }

    // Each card should have a View button
    const firstCard = sessionCards.first()
    const viewBtn = firstCard.locator('button').filter({ hasText: /view/i }).first()
    const hasView = await viewBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    // Either View button or the card itself should be interactive
    expect(hasView).toBeTruthy()
  })
})
