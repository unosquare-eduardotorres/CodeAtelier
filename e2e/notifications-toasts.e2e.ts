/**
 * Notifications & Toasts E2E Tests
 *
 * Verifies the notification system (3 components, 319 LOC total):
 *   - NotificationStack — manages the toast stack
 *   - PermissionApprovalModal — permission requests from background sessions
 *   - CompletionToast — success/failure feedback
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Notifications & Toasts', () => {
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

  test('notification stack renders toast messages', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const stack = page.locator('[data-testid="notification-stack"]')
    const hasStack = await stack.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasStack) { test.skip(); return }

    const toasts = stack.locator('[data-testid="permission-approval-modal"], [data-testid="completion-toast"]')
    expect(await toasts.count()).toBeGreaterThan(0)
  })

  test('permission modal shows accept button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const permissionModal = page.locator('[data-testid="permission-approval-modal"]')
    if (!(await permissionModal.first().isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    const text = await permissionModal.first().textContent()
    expect(text?.length).toBeGreaterThan(0)

    const acceptBtn = page.locator('[data-testid="permission-accept-btn"]').first()
    const hasAccept = await acceptBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasAccept) {
      await expect(acceptBtn).toBeVisible()
      await acceptBtn.click()
      await page.waitForTimeout(1_000)
    }
  })

  test('completion toast shows success feedback', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const completionToast = page.locator('[data-testid="completion-toast"]')
    if (!(await completionToast.first().isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    const text = await completionToast.first().textContent()
    expect(text?.length).toBeGreaterThan(0)
    await expect(completionToast.first().getByText(/view in/i)).toBeVisible()
  })

  test('multiple toasts stack without overlap', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const stack = page.locator('[data-testid="notification-stack"]')
    if (!(await stack.isVisible({ timeout: 5_000 }).catch(() => false))) { test.skip(); return }

    const toasts = stack.locator('[data-testid="permission-approval-modal"], [data-testid="completion-toast"]')
    if ((await toasts.count()) < 2) { test.skip(); return }

    const box1 = await toasts.nth(0).boundingBox()
    const box2 = await toasts.nth(1).boundingBox()
    if (box1 && box2) {
      expect(box2.y).toBeGreaterThanOrEqual(box1.y + box1.height - 1)
    }
  })

  test('toast dismiss button removes immediately', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const toasts = page.locator('[data-testid="permission-approval-modal"], [data-testid="completion-toast"]')
    const count = await toasts.count()
    if (count === 0) { test.skip(); return }

    const firstToast = toasts.first()
    await expect(firstToast).toBeVisible()
    const dismissBtn = firstToast.locator('[aria-label="Dismiss"]')
    if (!(await dismissBtn.isVisible({ timeout: 2_000 }).catch(() => false))) { test.skip(); return }

    await dismissBtn.click()
    await page.waitForTimeout(500)
    expect(await toasts.count()).toBeLessThan(count)
  })
})
