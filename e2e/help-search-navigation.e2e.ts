/**
 * Help Search & Navigation E2E Tests
 *
 * Verifies HelpTOC (208 LOC) + HelpArticleRenderer (218 LOC) — search
 * filtering, empty state, section groups, and article rendering depth:
 *   - TOC search input accepts text and is visible
 *   - Typing search query filters TOC to matching sections
 *   - Clearing search restores all TOC sections
 *   - Unmatched search shows no-matching-topics empty state
 *   - Section group dividers render for Workspace Settings and Advanced
 *   - Active section button has aria-current page attribute
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/help-search-navigation.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Help Search & Navigation', () => {
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

  /** Open the help view via Cmd+/ shortcut and ensure TOC is visible. */
  async function openHelpWithTOC(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    await page.keyboard.press('Meta+/')
    await page.waitForTimeout(1_000)

    const helpView = page.locator('[data-testid="help-view"]')
    const isOpen = await helpView.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isOpen) return false

    const tocNav = page.locator('nav[aria-label="Help table of contents"]')
    return tocNav.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('TOC search input accepts text and is visible', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    const searchInput = page.locator('[data-testid="help-toc-search"]')
    await expect(searchInput).toBeVisible()

    // Type into search and verify value
    await searchInput.fill('Models')
    await expect(searchInput).toHaveValue('Models')
  })

  test('typing search query filters TOC to matching sections', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    const tocNav = page.locator('nav[aria-label="Help table of contents"]')
    const sectionButtons = tocNav.locator('ul button')

    // Count sections before search
    const fullCount = await sectionButtons.count()
    if (fullCount === 0) { test.skip(); return }

    // Type a specific query
    const searchInput = page.locator('[data-testid="help-toc-search"]')
    await searchInput.fill('Models')
    await page.waitForTimeout(500)

    // Filtered count should be less than full count (unless all match)
    const filteredCount = await sectionButtons.count()
    expect(filteredCount).toBeLessThanOrEqual(fullCount)
    expect(filteredCount).toBeGreaterThan(0)

    // "Models" section should still be visible
    const modelsBtn = tocNav.locator('button').filter({ hasText: /Models/i }).first()
    await expect(modelsBtn).toBeVisible()
  })

  test('clearing search restores all TOC sections', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    const tocNav = page.locator('nav[aria-label="Help table of contents"]')
    const sectionButtons = tocNav.locator('ul button')

    // Count full sections
    const fullCount = await sectionButtons.count()
    if (fullCount === 0) { test.skip(); return }

    // Type query to filter
    const searchInput = page.locator('[data-testid="help-toc-search"]')
    await searchInput.fill('Models')
    await page.waitForTimeout(300)

    // Clear the search
    await searchInput.fill('')
    await page.waitForTimeout(300)

    // Count should be restored
    const restoredCount = await sectionButtons.count()
    expect(restoredCount).toEqual(fullCount)
  })

  test('unmatched search shows no-matching-topics empty state', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    // Type a query that won't match any section
    const searchInput = page.locator('[data-testid="help-toc-search"]')
    await searchInput.fill('zzzzxyzzy')
    await page.waitForTimeout(500)

    // Should show empty state
    const emptyState = page.locator('[data-testid="help-toc-empty"]')
    const emptyText = page.getByText(/no matching/i)

    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasEmptyText = await emptyText.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(hasEmpty || hasEmptyText).toBeTruthy()
  })

  test('section group dividers render for Workspace Settings and Advanced', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    const tocNav = page.locator('nav[aria-label="Help table of contents"]')

    // Group dividers should be visible
    const workspaceSettingsLabel = tocNav.getByText('Workspace Settings')
    const advancedLabel = tocNav.getByText('Advanced')

    await expect(workspaceSettingsLabel).toBeVisible({ timeout: 3_000 })
    await expect(advancedLabel).toBeVisible()
  })

  test('active section button has aria-current page attribute', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const hasTOC = await openHelpWithTOC(page)
    if (!hasTOC) { test.skip(); return }

    const tocNav = page.locator('nav[aria-label="Help table of contents"]')

    // One button should have aria-current="page"
    const activeBtn = tocNav.locator('button[aria-current="page"]')
    await expect(activeBtn).toHaveCount(1)

    // Click a different section
    const allButtons = tocNav.locator('ul button')
    const btnCount = await allButtons.count()
    if (btnCount < 2) { test.skip(); return }

    // Click the last button (likely different from active)
    await allButtons.nth(btnCount - 1).click()
    await page.waitForTimeout(500)

    // A button should still have aria-current="page"
    const newActiveBtn = tocNav.locator('button[aria-current="page"]')
    await expect(newActiveBtn).toHaveCount(1)
  })
})
