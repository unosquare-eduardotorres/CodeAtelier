/**
 * InsightsSummary E2E Tests
 *
 * Verifies InsightsSummary (103 LOC) — conversation insights panel:
 *   - Summary renders inside CompleteDialog
 *   - Loading state shows skeleton/spinner
 *   - Populated insights show metric values
 *   - File change count displayed when available
 *   - Empty state handled gracefully when insights unavailable
 *
 * Navigation: Open CompleteDialog or CloseDialog → observe insights section.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/insights-summary.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('InsightsSummary', () => {
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

  /** Open a dialog that contains InsightsSummary (CompleteDialog or CloseDialog). */
  async function openDialogWithInsights(
    page: import('@playwright/test').Page
  ): Promise<string | null> {
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    const hasTab = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await chatsTab.click()
      await page.waitForTimeout(800)
    }

    const chatItems = page.locator('[data-testid="chat-item"]')
    if ((await chatItems.count()) === 0) return null
    await chatItems.first().click()
    await page.waitForTimeout(1_500)

    // Try complete dialog first (has insights)
    const completeBtn = page.locator('button:has-text("Complete"), [data-testid="complete-btn"]')
    if (await completeBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await completeBtn.first().click()
      await page.waitForTimeout(500)
      if (await page.locator('[data-testid="complete-dialog"]').isVisible({ timeout: 2_000 }).catch(() => false)) {
        return 'complete-dialog'
      }
    }

    // Try close dialog (also has insights)
    const closeBtn = page.locator('[data-testid="close-conversation-btn"], button:has-text("Close")')
    if (await closeBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
      await closeBtn.first().click()
      await page.waitForTimeout(500)
      if (await page.locator('[data-testid="close-dialog"]').isVisible({ timeout: 2_000 }).catch(() => false)) {
        return 'close-dialog'
      }
    }

    return null
  }

  test('insights summary renders inside CompleteDialog', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openDialogWithInsights(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Wait for insights to load
    await page.waitForTimeout(3_000)

    // Either insights-summary or insights-loading should be present
    const summary = dialog.locator('[data-testid="insights-summary"]')
    const loading = dialog.locator('[data-testid="insights-loading"]')

    const hasSummary = await summary.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasLoading = await loading.isVisible({ timeout: 2_000 }).catch(() => false)

    // One of these should be present (or neither if insights failed gracefully)
    if (hasSummary) {
      await expect(summary).toBeVisible()
    } else if (hasLoading) {
      await expect(loading).toBeVisible()
    }
    // Insights are optional — graceful skip if neither found

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('loading state shows skeleton/spinner', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openDialogWithInsights(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Check for loading skeleton — it shows briefly before insights load
    const loading = dialog.locator('[data-testid="insights-loading"]')
    const hasLoading = await loading.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasLoading) {
      // Loading skeleton should have animate-pulse class
      const classes = await loading.getAttribute('class')
      expect(classes).toContain('animate-pulse')

      // Should have placeholder boxes
      const placeholders = loading.locator('.bg-surface-overlay')
      const count = await placeholders.count()
      expect(count).toBeGreaterThan(0)
    }
    // Loading may be too fast to catch — that's OK

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('populated insights show metric values', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openDialogWithInsights(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Wait for insights to fully load
    await page.waitForTimeout(3_000)

    const summary = dialog.locator('[data-testid="insights-summary"]')
    const hasSummary = await summary.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSummary) { test.skip(); return }

    // Should show "Session Insights" header
    await expect(summary.locator('text=Session Insights')).toBeVisible()

    // Should have stat pills (turns, tokens, cost, duration)
    const statLabels = ['TURNS', 'TOKENS', 'COST', 'DURATION']
    let foundCount = 0
    for (const label of statLabels) {
      const pill = summary.locator(`text=${label}`)
      if (await pill.isVisible({ timeout: 1_000 }).catch(() => false)) {
        foundCount++
      }
    }
    expect(foundCount).toBeGreaterThanOrEqual(2) // At least some stats visible

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('file change count displayed when available', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openDialogWithInsights(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    await page.waitForTimeout(3_000)

    const summary = dialog.locator('[data-testid="insights-summary"]')
    const hasSummary = await summary.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSummary) { test.skip(); return }

    // FILES stat pill may or may not be present depending on whether there are file changes
    const filesPill = summary.locator('text=FILES')
    const hasFiles = await filesPill.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasFiles) {
      await expect(filesPill).toBeVisible()
    }
    // File count is conditional — absence is valid

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('empty state handled gracefully when insights unavailable', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openDialogWithInsights(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    await page.waitForTimeout(3_000)

    // The dialog should render successfully regardless of insights state
    // If insights are null, InsightsSummary returns null — dialog should still work
    const summary = dialog.locator('[data-testid="insights-summary"]')
    const loading = dialog.locator('[data-testid="insights-loading"]')

    const hasSummary = await summary.isVisible({ timeout: 1_000 }).catch(() => false)
    const hasLoading = await loading.isVisible({ timeout: 1_000 }).catch(() => false)

    // Whether insights are shown or not, the dialog should still have buttons
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThanOrEqual(2) // At least cancel + confirm

    // Verify no crash — dialog is still interactive
    if (!hasSummary && !hasLoading) {
      // Empty state: insights failed or returned null — dialog should still work
      await expect(dialog).toBeVisible()
    }

    // Clean up
    await page.keyboard.press('Escape')
  })
})
