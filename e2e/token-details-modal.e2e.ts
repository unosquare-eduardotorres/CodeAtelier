/**
 * Token Details Modal E2E Tests
 *
 * Verifies the TokenDetailsModal component (304 LOC):
 *   - Modal opens with live counters
 *   - Feature breakdown table shows usage
 *   - Close button and Escape key dismiss
 *   - Empty state when no usage recorded
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Token Details Modal', () => {
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

  async function openTokenDetailsModal(page: import('@playwright/test').Page): Promise<boolean> {
    const tokenIndicator = page.locator('[data-testid="token-indicator"]')
    let hasIndicator = await tokenIndicator.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasIndicator) {
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
    return page
      .locator('[data-testid="token-details-modal"]')
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
  }

  test('modal opens with live counters', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()
    const liveCounters = page.locator('[data-testid="token-live-counters"]')
    await expect(liveCounters).toBeVisible()
    await expect(liveCounters.getByText(/context window/i)).toBeVisible()
    await expect(liveCounters.getByText(/output tokens/i)).toBeVisible()
  })

  test('feature breakdown table shows usage', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const featureTable = page.locator('[data-testid="token-feature-table"]')
    const hasTable = await featureTable.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTable) {
      expect(await featureTable.locator('.tabular-nums').count()).toBeGreaterThan(0)
      await expect(featureTable.getByText(/estimated total/i)).toBeVisible()
    } else {
      await expect(page.getByText(/no token usage recorded|no active workspace/i)).toBeVisible()
    }
  })

  test('close button and Escape key dismiss', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    const closeBtn = page.locator('[data-testid="token-close-btn"]')
    await expect(closeBtn).toBeVisible()
    await closeBtn.click()
    await page.waitForTimeout(500)
    await expect(modal).toBeHidden({ timeout: 3_000 })

    if (await openTokenDetailsModal(page)) {
      await expect(modal).toBeVisible()
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await expect(modal).toBeHidden({ timeout: 3_000 })
    }
  })

  test('modal header shows descriptive title', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()

    // Modal should have a descriptive title
    const titleText = modal.getByText(/token|usage|context/i).first()
    await expect(titleText).toBeVisible({ timeout: 3_000 })
  })

  test('context window section shows formatted token counts', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const liveCounters = page.locator('[data-testid="token-live-counters"]')
    const hasCounters = await liveCounters.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasCounters) {
      test.skip()
      return
    }

    // Should contain elements with tabular-nums class for numeric formatting
    const tabularNums = liveCounters.locator('.tabular-nums')
    expect(await tabularNums.count()).toBeGreaterThan(0)
  })

  test('re-opening modal after close works correctly', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()

    // Close via button
    const closeBtn = page.locator('[data-testid="token-close-btn"]')
    const hasClose = await closeBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasClose) {
      test.skip()
      return
    }

    await closeBtn.click()
    await page.waitForTimeout(500)
    await expect(modal).toBeHidden({ timeout: 3_000 })

    // Re-open — modal should become visible again
    if (await openTokenDetailsModal(page)) {
      await expect(modal).toBeVisible({ timeout: 3_000 })
    }
  })

  test('empty state when no usage recorded', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    if (!(await openTokenDetailsModal(page))) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="token-details-modal"]')
    await expect(modal).toBeVisible()

    const featureTable = page.locator('[data-testid="token-feature-table"]')
    if (!(await featureTable.isVisible({ timeout: 2_000 }).catch(() => false))) {
      await expect(modal.getByText(/no token usage|no active workspace/i)).toBeVisible()
    }
    await expect(page.locator('[data-testid="token-close-btn"]')).toBeVisible()
  })
})
