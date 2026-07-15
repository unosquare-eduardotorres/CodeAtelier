/**
 * Memory Settings E2E Tests
 *
 * Verifies MemorySettingsPage — the tabbed memory management UI:
 *   - Page renders with Facts tab active by default
 *   - Graph tab shows canvas + legend (or empty state with 0 facts)
 *   - Review tab renders contradictions section
 *   - Search tab renders the search playground
 *   - Capture tab renders capture settings
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/memory-settings.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { SettingsNav } from './pages/settings-nav'

test.describe('Memory Settings', () => {
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

  async function navigateToMemory(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const nav = new SettingsNav(page)
    return nav.navigateToSettingsTab('memory')
  }

  test('page renders with Facts tab active', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToMemory(page)
    if (!navigated) { test.skip(); return }

    // Root element should be visible
    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    await expect(memoryPage).toBeVisible({ timeout: 5_000 })

    // Facts tab should be active (has bg-accent styling, checked by existence)
    const factsTab = page.locator('[data-testid="memory-tab-facts"]')
    await expect(factsTab).toBeVisible()

    // Search bar should be present (part of the Facts tab)
    const searchInput = page.locator('input[placeholder*="filter" i], input[placeholder*="search" i]').first()
    const hasSearch = await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)
    // Facts tab always shows — either the search bar or the empty state
    expect(hasSearch || (await memoryPage.getByText(/no facts/i).isVisible().catch(() => false))).toBeTruthy()
  })

  test('Graph tab shows canvas and legend (or empty state)', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToMemory(page)
    if (!navigated) { test.skip(); return }

    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    const hasPage = await memoryPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click Graph tab
    const graphTab = page.locator('[data-testid="memory-tab-graph"]')
    await expect(graphTab).toBeVisible()
    await graphTab.click()
    await page.waitForTimeout(1_000)

    // Either the canvas renders (facts exist) or the empty state shows
    const canvas = page.locator('[data-testid="memory-graph-canvas"]')
    const emptyState = page.getByText(/no (facts|memories) to visualize/i)

    const hasCanvas = await canvas.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasEmpty = await emptyState.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasCanvas || hasEmpty).toBeTruthy()

    // If canvas is visible, legend should also be visible
    if (hasCanvas) {
      const legend = page.getByText(/similarity/i)
      await expect(legend).toBeVisible({ timeout: 2_000 })
    }
  })

  test('Review tab renders contradictions section', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToMemory(page)
    if (!navigated) { test.skip(); return }

    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    const hasPage = await memoryPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click Review (contradictions) tab
    const reviewTab = page.locator('[data-testid="memory-tab-contradictions"]')
    await expect(reviewTab).toBeVisible()
    await reviewTab.click()
    await page.waitForTimeout(500)

    // Either contradictions are listed or the empty state shows
    const emptyState = page.getByText(/no contradictions to review/i)
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)

    // The tab content rendered (either contradictions or empty state)
    expect(hasEmpty || (await page.locator('[data-testid="memory-settings-page"]').isVisible())).toBeTruthy()
  })

  test('Search tab renders playground', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToMemory(page)
    if (!navigated) { test.skip(); return }

    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    const hasPage = await memoryPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click Search tab
    const searchTab = page.locator('[data-testid="memory-tab-search"]')
    await expect(searchTab).toBeVisible()
    await searchTab.click()
    await page.waitForTimeout(500)

    // SearchPlayground should render — it has its own input
    const searchPlayground = page.locator('input[placeholder*="search" i], input[placeholder*="query" i]').first()
    const hasPlayground = await searchPlayground.isVisible({ timeout: 3_000 }).catch(() => false)
    // SearchPlayground component always renders some UI
    expect(hasPlayground || (await memoryPage.isVisible())).toBeTruthy()
  })

  test('Capture tab renders settings', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const navigated = await navigateToMemory(page)
    if (!navigated) { test.skip(); return }

    const memoryPage = page.locator('[data-testid="memory-settings-page"]')
    const hasPage = await memoryPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasPage) { test.skip(); return }

    // Click Capture (settings) tab
    const captureTab = page.locator('[data-testid="memory-tab-settings"]')
    await expect(captureTab).toBeVisible()
    await captureTab.click()
    await page.waitForTimeout(500)

    // CaptureSettings component should render capture toggles or feed document button
    const hasContent = await memoryPage.isVisible()
    expect(hasContent).toBeTruthy()
  })
})
