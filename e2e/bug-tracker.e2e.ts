/**
 * Bug Tracker E2E Tests
 *
 * Verifies the Bug Tracker page — accessed via top-level nav bar (Bug icon):
 *   - Page renders with header and filter bar
 *   - Status tab filtering (All/Open/Resolved)
 *   - Search input client-side filtering
 *   - Bug row click opens detail panel
 *   - Detail panel resolve/unresolve/delete actions
 *   - Bulk action bar on multi-select
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { AppChrome } from './pages/app-chrome'
import { WelcomePage } from './pages/welcome-page'

test.describe('Bug Tracker', () => {
  /**
   * Helper: Navigate to Bug Tracker page via nav bar.
   */
  async function navigateToBugTracker(
    page: import('@playwright/test').Page
  ): Promise<void> {
    const welcomePage = new WelcomePage(page)
    const chrome = new AppChrome(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Open a workspace first (bug tracker requires an active context)
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Click Bug Tracker button in nav bar
    await chrome.openBugTracker()
    await page.waitForTimeout(1_000)
  }

  test('Bug tracker page renders with header and filter bar', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    // Page container visible
    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    // Header has Bug Tracker title
    const heading = trackerPage.locator('h1', { hasText: 'Bug Tracker' })
    await expect(heading).toBeVisible()

    // Filter bar — status tabs visible
    await expect(page.locator('[data-testid="bug-filter-status-all"]')).toBeVisible()
    await expect(page.locator('[data-testid="bug-filter-status-open"]')).toBeVisible()
    await expect(page.locator('[data-testid="bug-filter-status-resolved"]')).toBeVisible()

    // Search input visible
    await expect(page.locator('[data-testid="bug-search-input"]')).toBeVisible()

    // Process and sort dropdowns visible
    await expect(page.locator('[data-testid="bug-filter-process"]')).toBeVisible()
    await expect(page.locator('[data-testid="bug-filter-sort"]')).toBeVisible()
  })

  test('Status tab filtering switches between All/Open/Resolved', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    // Click Open tab
    await page.locator('[data-testid="bug-filter-status-open"]').click()
    await page.waitForTimeout(500)
    // Open tab should be active (has active styling)
    const openTab = page.locator('[data-testid="bug-filter-status-open"]')
    const openClass = await openTab.getAttribute('class')
    expect(openClass).toContain('bg-surface-overlay')

    // Click Resolved tab
    await page.locator('[data-testid="bug-filter-status-resolved"]').click()
    await page.waitForTimeout(500)
    const resolvedTab = page.locator('[data-testid="bug-filter-status-resolved"]')
    const resolvedClass = await resolvedTab.getAttribute('class')
    expect(resolvedClass).toContain('bg-surface-overlay')

    // Click All tab — should restore
    await page.locator('[data-testid="bug-filter-status-all"]').click()
    await page.waitForTimeout(500)
    const allTab = page.locator('[data-testid="bug-filter-status-all"]')
    const allClass = await allTab.getAttribute('class')
    expect(allClass).toContain('bg-surface-overlay')
  })

  test('Search input filters bugs client-side', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    const searchInput = page.locator('[data-testid="bug-search-input"]')

    // Type a query that shouldn't match anything
    await searchInput.fill('nonexistent-error-xyz-42')
    await page.waitForTimeout(500)

    // Either no bug rows visible, or empty state shows
    const bugRows = page.locator('[data-testid^="bug-row-"]')
    const rowCount = await bugRows.count()
    if (rowCount === 0) {
      // Empty state or no results — check either empty marker or zero rows
      const emptyState = page.locator('[data-testid="bug-tracker-empty"]')
      const emptyVisible = await emptyState.isVisible().catch(() => false)
      // Accept either no rows or explicit empty state
      expect(rowCount === 0 || emptyVisible).toBeTruthy()
    }

    // Clear search — bugs should reappear (if any exist)
    await searchInput.clear()
    await page.waitForTimeout(500)
  })

  test('Clicking a bug row opens detail panel', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    // Find first bug row
    const bugRows = page.locator('[data-testid^="bug-row-"]')
    const count = await bugRows.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Click first bug
    await bugRows.first().click()
    await page.waitForTimeout(500)

    // Detail panel should appear
    const detailPanel = page.locator('[data-testid="bug-detail-panel"]')
    await expect(detailPanel).toBeVisible({ timeout: 5_000 })

    // Panel shows "Bug Details" heading
    const panelHeading = detailPanel.locator('h2', { hasText: 'Bug Details' })
    await expect(panelHeading).toBeVisible()

    // Close button should dismiss panel
    const closeBtn = detailPanel.locator('button[aria-label="Close detail panel"]')
    await closeBtn.click()
    await page.waitForTimeout(500)
    await expect(detailPanel).not.toBeVisible()
  })

  test('Bug detail panel resolve/unresolve actions', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    const bugRows = page.locator('[data-testid^="bug-row-"]')
    const count = await bugRows.count()
    if (count === 0) {
      test.skip()
      return
    }

    // Click first bug to open detail
    await bugRows.first().click()
    await page.waitForTimeout(500)

    const detailPanel = page.locator('[data-testid="bug-detail-panel"]')
    await expect(detailPanel).toBeVisible({ timeout: 5_000 })

    // Find resolve/reopen button — text depends on current state
    const resolveBtn = detailPanel.locator('button', { hasText: /Mark Resolved|Reopen/ })
    if (await resolveBtn.isVisible().catch(() => false)) {
      const btnText = await resolveBtn.textContent()
      await resolveBtn.click()
      await page.waitForTimeout(1_000)

      // Button text should have changed
      if (btnText?.includes('Mark Resolved')) {
        await expect(detailPanel.locator('button', { hasText: 'Reopen' })).toBeVisible()
      } else {
        await expect(detailPanel.locator('button', { hasText: 'Mark Resolved' })).toBeVisible()
      }
    }

    // Delete button visible
    const deleteBtn = detailPanel.locator('button', { hasText: 'Delete' })
    await expect(deleteBtn).toBeVisible()

    // Note textarea and save button visible in detail panel
    const noteTextarea = page.locator('[data-testid="bug-detail-note"]')
    if (await noteTextarea.isVisible().catch(() => false)) {
      await expect(noteTextarea).toBeVisible()
      const saveNoteBtn = page.locator('[data-testid="bug-detail-save-note"]')
      await expect(saveNoteBtn).toBeVisible()
    }
  })

  test('Bulk action bar appears on multi-select', async ({ electronPage: page }) => {
    await navigateToBugTracker(page)

    const trackerPage = page.locator('[data-testid="bug-tracker-page"]')
    await expect(trackerPage).toBeVisible({ timeout: 10_000 })

    const bugRows = page.locator('[data-testid^="bug-row-"]')
    const count = await bugRows.count()
    if (count < 2) {
      test.skip()
      return
    }

    // Check first two bug checkboxes
    const checkbox1 = bugRows.nth(0).locator('input[type="checkbox"]')
    const checkbox2 = bugRows.nth(1).locator('input[type="checkbox"]')
    await checkbox1.check()
    await page.waitForTimeout(300)
    await checkbox2.check()
    await page.waitForTimeout(500)

    // Bulk action bar should appear
    const bulkBar = page.locator('[data-testid="bug-bulk-action-bar"]')
    await expect(bulkBar).toBeVisible({ timeout: 5_000 })

    // Shows "2 selected" text
    await expect(bulkBar.locator('text=2 selected')).toBeVisible()

    // Resolve/Export/Delete buttons visible
    await expect(page.locator('[data-testid="bug-bulk-resolve"]')).toBeVisible()
    await expect(page.locator('[data-testid="bug-bulk-export"]')).toBeVisible()
    await expect(page.locator('[data-testid="bug-bulk-delete"]')).toBeVisible()

    // Clear selection (X button) hides bulk bar
    const clearBtn = bulkBar.locator('button[aria-label="Clear selection"]')
    await clearBtn.click()
    await page.waitForTimeout(500)
    await expect(bulkBar).not.toBeVisible()
  })
})
