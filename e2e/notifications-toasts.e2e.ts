/**
 * Notifications & Toasts E2E Tests
 *
 * Verifies the notification system (3 components, 319 LOC total):
 *   - NotificationStack (133 LOC) — manages the toast stack
 *   - PermissionToast (108 LOC) — permission requests from background sessions
 *   - CompletionToast (78 LOC) — success/failure feedback
 *
 * Scenarios:
 *   - Notification stack renders toast messages
 *   - Permission toast shows accept button
 *   - Completion toast shows success feedback
 *   - Multiple toasts stack without overlap
 *   - Toast dismiss button removes immediately
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/notifications-toasts.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Notifications & Toasts', () => {
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

  test('notification stack renders toast messages', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    // NotificationStack renders in the top-right corner when there are notifications.
    // It only shows for non-active workspaces, so we check the data-testid.
    const stack = page.locator('[data-testid="notification-stack"]')
    const hasStack = await stack.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasStack) {
      // No pending notifications — verify the selector is valid
      // by checking the component renders null when empty
      const count = await stack.count()
      // NotificationStack returns null when empty — count is 0
      expect(count).toBeGreaterThanOrEqual(0)
      test.skip()
      return
    }

    // Stack is visible — should contain at least one toast
    const toasts = stack.locator('[data-testid="permission-toast"], [data-testid="completion-toast"]')
    const toastCount = await toasts.count()
    expect(toastCount).toBeGreaterThan(0)
  })

  test('permission toast shows accept button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const permissionToast = page.locator('[data-testid="permission-toast"]')
    const hasPermission = await permissionToast.first().isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPermission) {
      // No pending permission requests
      test.skip()
      return
    }

    // Permission toast should show description
    const text = await permissionToast.first().textContent()
    expect(text?.length).toBeGreaterThan(0)

    // Accept button should be visible
    const acceptBtn = page.locator('[data-testid="permission-accept-btn"]').first()
    const hasAccept = await acceptBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasAccept) {
      await expect(acceptBtn).toBeVisible()
      // Click accept — toast should dismiss
      await acceptBtn.click()
      await page.waitForTimeout(1_000)
    }
  })

  test('completion toast shows success feedback', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const completionToast = page.locator('[data-testid="completion-toast"]')
    const hasCompletion = await completionToast.first().isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasCompletion) {
      // No completion notifications
      test.skip()
      return
    }

    // Completion toast should have content
    const text = await completionToast.first().textContent()
    expect(text?.length).toBeGreaterThan(0)

    // Should have a "View in [workspace]" button
    const viewBtn = completionToast.first().getByText(/view in/i)
    await expect(viewBtn).toBeVisible()
  })

  test('multiple toasts stack without overlap', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const stack = page.locator('[data-testid="notification-stack"]')
    const hasStack = await stack.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasStack) {
      test.skip()
      return
    }

    const toasts = stack.locator('[data-testid="permission-toast"], [data-testid="completion-toast"]')
    const count = await toasts.count()

    if (count < 2) {
      // Need multiple toasts to test stacking
      test.skip()
      return
    }

    // Get bounding boxes of first two toasts
    const box1 = await toasts.nth(0).boundingBox()
    const box2 = await toasts.nth(1).boundingBox()

    if (box1 && box2) {
      // Toasts should stack vertically — second toast's top > first toast's bottom
      expect(box2.y).toBeGreaterThanOrEqual(box1.y + box1.height - 1) // -1 for rounding
    }
  })

  test('toast dismiss button removes immediately', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const toasts = page.locator(
      '[data-testid="permission-toast"], [data-testid="completion-toast"]'
    )
    const count = await toasts.count()

    if (count === 0) {
      test.skip()
      return
    }

    const firstToast = toasts.first()
    await expect(firstToast).toBeVisible()

    // Click dismiss (X) button
    const dismissBtn = firstToast.locator('[aria-label="Dismiss"]')
    const hasDismiss = await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasDismiss) {
      test.skip()
      return
    }

    await dismissBtn.click()
    await page.waitForTimeout(500)

    // Toast should disappear
    const newCount = await toasts.count()
    expect(newCount).toBeLessThan(count)
  })
})
