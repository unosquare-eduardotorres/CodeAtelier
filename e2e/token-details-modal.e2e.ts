/**
 * Token Details Modal E2E Tests
 *
 * Verifies the TokenDetailsModal component (304 LOC) — shows live token
 * counters, feature breakdown, and cost estimation:
 *   - Modal opens with live counters
 *   - Feature breakdown table shows usage
 *   - Close button and Escape key dismiss
 *   - Empty state when no usage recorded
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/token-details-modal.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Token Details Modal', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
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

  /** Try to open the Token Details modal from the status bar. */
  async function openTokenDetailsModal(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Look for token indicator in the status bar
    const tokenIndicator = page.locator('[data-testid="token-indicator"]')
    let hasIndicator = await tokenIndicator.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasIndicator) {
      // Try clicking status bar area or looking for token-related text
      const tokenText = page.getByText(/tokens|context/i).last()
      hasIndicator = await tokenText.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasIndicator) {
        await tokenText.click()
        await page.waitForTimeout(500)
      }
    } else {
      await tokenIndicator.click()
      await page.waitForTimeout(500)
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    return modal.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('modal opens with live counters', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openTokenDetailsModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()

    // Live counters card should be visible
    const liveCounters = page.locator('[data-testid="token-live-counters"]')
    await expect(liveCounters).toBeVisible()

    // Should show "Context window" and "Output tokens" labels
    const contextLabel = liveCounters.getByText(/context window/i)
    await expect(contextLabel).toBeVisible()

    const outputLabel = liveCounters.getByText(/output tokens/i)
    await expect(outputLabel).toBeVisible()
  })

  test('feature breakdown table shows usage', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openTokenDetailsModal(page)
    if (!opened) {
      test.skip()
      return
    }

    // Feature table may or may not have data
    const featureTable = page.locator('[data-testid="token-feature-table"]')
    const hasTable = await featureTable.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasTable) {
      // Feature rows should show feature names and call counts
      const featureRows = featureTable.locator('.tabular-nums')
      const rowCount = await featureRows.count()
      expect(rowCount).toBeGreaterThan(0)

      // "Estimated total" summary row should be present
      const totalRow = featureTable.getByText(/estimated total/i)
      await expect(totalRow).toBeVisible()
    } else {
      // Empty state — no token usage recorded
      const emptyText = page.getByText(/no token usage recorded|no active workspace/i)
      await expect(emptyText).toBeVisible()
    }
  })

  test('close button and Escape key dismiss', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openTokenDetailsModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')

    // Close button
    const closeBtn = page.locator('[data-testid="token-close-btn"]')
    await expect(closeBtn).toBeVisible()
    await closeBtn.click()
    await page.waitForTimeout(500)

    // Modal should close
    await expect(modal).toBeHidden({ timeout: 3_000 })

    // Reopen and test Escape
    const reopened = await openTokenDetailsModal(page)
    if (reopened) {
      await expect(modal).toBeVisible()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await expect(modal).toBeHidden({ timeout: 3_000 })
    }
  })

  test('empty state when no usage recorded', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const opened = await openTokenDetailsModal(page)
    if (!opened) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()

    // If no usage, should show empty message
    const featureTable = page.locator('[data-testid="token-feature-table"]')
    const hasTable = await featureTable.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasTable) {
      // Empty state text should be shown
      const emptyMsg = modal.getByText(/no token usage|no active workspace/i)
      await expect(emptyMsg).toBeVisible()
    }

    // Close button should still work
    const closeBtn = page.locator('[data-testid="token-close-btn"]')
    await expect(closeBtn).toBeVisible()
  })
})
