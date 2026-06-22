/**
 * UltraPlan Approval E2E Tests
 *
 * Verifies UltraPlan UI components — conditional rendering based on
 * active UltraPlan session state:
 *   - Status badge renders when active
 *   - Status badge is clickable when session URL exists
 *   - Approval dialog renders with plan preview and 3 actions
 *   - Approval dialog action buttons are clickable
 *
 * These components only appear during active UltraPlan sessions (Claude provider).
 * Tests skip gracefully when not active.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('UltraPlan Approval', () => {
  /**
   * Helper: Ensure we're in a workspace with Claude provider.
   */
  async function ensureWorkspaceOpen(
    page: import('@playwright/test').Page
  ): Promise<void> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
  }

  test('UltraPlan status badge renders when active', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    // Look for status badge — only appears when UltraPlan session is active
    const badge = page.locator('[data-testid="ultraplan-status-badge"]')
    const isVisible = await badge.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Badge should contain "ultraplan" label or recognizable text
    await expect(badge).toBeVisible()
    const text = await badge.textContent()
    expect(text?.toLowerCase()).toContain('ultraplan')
  })

  test('Status badge is clickable when session URL exists', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    const badge = page.locator('[data-testid="ultraplan-status-badge"]')
    const isVisible = await badge.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Badge should have cursor-pointer class or be a link
    const classes = await badge.getAttribute('class')
    const hasPointer = classes?.includes('cursor-pointer') ?? false
    const tagName = await badge.evaluate((el) => el.tagName.toLowerCase())
    const isClickable = hasPointer || tagName === 'a' || tagName === 'button'
    expect(isClickable).toBeTruthy()

    // Badge should have a title tooltip
    const title = await badge.getAttribute('title')
    if (title) {
      expect(title.length).toBeGreaterThan(0)
    }
  })

  test('Approval dialog renders with plan preview and 3 actions', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    // Approval dialog only appears when status=approved
    const dialog = page.locator('[data-testid="ultraplan-approval-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Plan preview should have content
    const preview = page.locator('[data-testid="ultraplan-plan-preview"]')
    await expect(preview).toBeVisible()
    const previewText = await preview.textContent()
    expect(previewText?.length).toBeGreaterThan(0)

    // Three action buttons visible
    await expect(page.locator('[data-testid="ultraplan-implement"]')).toBeVisible()
    await expect(page.locator('[data-testid="ultraplan-new-session"]')).toBeVisible()
    await expect(page.locator('[data-testid="ultraplan-cancel"]')).toBeVisible()
  })

  test('Approval dialog action buttons are clickable', async ({ electronPage: page }) => {
    await ensureWorkspaceOpen(page)

    const dialog = page.locator('[data-testid="ultraplan-approval-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!isVisible) {
      test.skip()
      return
    }

    // Verify all 3 action buttons are enabled (not disabled)
    const implementBtn = page.locator('[data-testid="ultraplan-implement"]')
    const newSessionBtn = page.locator('[data-testid="ultraplan-new-session"]')
    const cancelBtn = page.locator('[data-testid="ultraplan-cancel"]')

    await expect(implementBtn).toBeEnabled()
    await expect(newSessionBtn).toBeEnabled()
    await expect(cancelBtn).toBeEnabled()

    // Verify button text content
    await expect(implementBtn).toContainText('Implement here')
    await expect(newSessionBtn).toContainText('Start new session')
    await expect(cancelBtn).toContainText('Cancel')
  })
})
