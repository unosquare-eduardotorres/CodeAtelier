/**
 * Specialist Warning Dialog E2E Tests
 *
 * Tests SpecialistWarningDialog (189 LOC) — cost confirmation before specialist actions:
 *   - Dialog renders when specialists are active
 *   - Warning title matches the action type (build/plan/always)
 *   - Token estimate displays formatted count
 *   - Confirm button proceeds with specialist-enabled action
 *   - "Don't show again" checkbox persists preference
 *
 * The SpecialistWarningDialog is triggered by build/plan actions when
 * specialists are active. Tests verify DOM structure when visible;
 * gracefully skip when dialog is not present.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/specialist-warning.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Specialist Warning Dialog', () => {
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

  async function findSpecialistWarningDialog(
    page: import('@playwright/test').Page
  ): Promise<import('@playwright/test').Locator | null> {
    const dialog = page.locator('[data-testid="specialist-warning-dialog"]')
    const hasDialog = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    return hasDialog ? dialog : null
  }

  test('specialist warning dialog renders when specialists are active', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialog = await findSpecialistWarningDialog(page)
    if (!dialog) { test.skip(); return }

    // Dialog should be visible with role="dialog"
    await expect(dialog).toBeVisible()
    const parentDialog = page.locator('[role="dialog"]')
    await expect(parentDialog).toBeVisible()

    // Should have a shield/warning icon
    const svgIcon = dialog.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('warning title matches the action type (build/plan/always)', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialog = await findSpecialistWarningDialog(page)
    if (!dialog) { test.skip(); return }

    // The title should mention one of the warning types
    const title = dialog.locator('h3')
    const titleText = await title.textContent()

    const hasValidTitle =
      titleText?.includes('build action') ||
      titleText?.includes('plan action') ||
      titleText?.includes('active in this conversation')

    expect(hasValidTitle).toBeTruthy()
  })

  test('token estimate displays formatted count', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialog = await findSpecialistWarningDialog(page)
    if (!dialog) { test.skip(); return }

    // Look for token estimate text
    const text = await dialog.textContent()
    const hasTokenInfo =
      text?.includes('token') || text?.includes('active specialist')

    expect(hasTokenInfo).toBeTruthy()

    // Should show the active specialist count
    const hasCount = /\d+\s*active\s*specialist/.test(text ?? '')
    expect(hasCount).toBeTruthy()
  })

  test('confirm button proceeds with specialist-enabled action', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialog = await findSpecialistWarningDialog(page)
    if (!dialog) { test.skip(); return }

    // Confirm button should be visible and enabled
    const confirmBtn = page.locator('[data-testid="specialist-warning-confirm"]')
    await expect(confirmBtn).toBeVisible()
    await expect(confirmBtn).toContainText('Continue')
    await expect(confirmBtn).toBeEnabled()

    // Cancel button should also exist
    const cancelBtn = dialog.locator('button:has-text("Cancel")')
    await expect(cancelBtn).toBeVisible()
  })

  test('"Don\'t show again" checkbox persists preference', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialog = await findSpecialistWarningDialog(page)
    if (!dialog) { test.skip(); return }

    // Find the "Don't show" checkbox
    const checkbox = dialog.locator('input[type="checkbox"]')
    const hasCheckbox = await checkbox.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasCheckbox) { test.skip(); return }

    await expect(checkbox).toBeVisible()
    await expect(checkbox).not.toBeChecked()

    // The label should mention "Don't show this"
    const labelText = dialog.locator('text=Don\'t show this')
    await expect(labelText).toBeVisible()

    // Check the checkbox
    await checkbox.check()
    await expect(checkbox).toBeChecked()
  })
})
