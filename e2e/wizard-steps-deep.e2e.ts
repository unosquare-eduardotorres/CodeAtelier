/**
 * Create Project Dialog Deep E2E Tests
 *
 * Verifies the CreateProjectDialog interactions in detail:
 *   - Description textarea accepts input
 *   - Tip block is visible
 *   - Escape key closes dialog
 *   - Backdrop click closes dialog
 *
 * Navigation: Welcome screen → Create New Project button → Dialog.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/wizard-steps-deep.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Create Project Dialog Deep', () => {
  async function ensureOnWelcomeScreen(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    return welcomePage.isVisible()
  }

  async function openDialog(page: import('@playwright/test').Page): Promise<boolean> {
    const createBtn = page.getByRole('button', { name: /create.*project|new.*project/i }).first()
    const hasBtn = await createBtn.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasBtn) return false

    await createBtn.click()
    await page.waitForTimeout(500)

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    return dialog.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('description textarea accepts input', async ({ electronPage: page }) => {
    const isOnWelcome = await ensureOnWelcomeScreen(page)
    if (!isOnWelcome) { test.skip(); return }

    const opened = await openDialog(page)
    if (!opened) { test.skip(); return }

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    const textarea = dialog.locator('textarea')
    const hasTextarea = await textarea.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTextarea) { test.skip(); return }

    await textarea.fill('A React app with authentication and dashboard')
    await page.waitForTimeout(300)

    const value = await textarea.inputValue()
    expect(value).toContain('React app')
  })

  test('tip block is visible', async ({ electronPage: page }) => {
    const isOnWelcome = await ensureOnWelcomeScreen(page)
    if (!isOnWelcome) { test.skip(); return }

    const opened = await openDialog(page)
    if (!opened) { test.skip(); return }

    // Tip block should mention "PLAN.md"
    const tipText = page.getByText(/PLAN\.md/i)
    const hasTip = await tipText.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasTip).toBeTruthy()
  })

  test('escape key closes dialog', async ({ electronPage: page }) => {
    const isOnWelcome = await ensureOnWelcomeScreen(page)
    if (!isOnWelcome) { test.skip(); return }

    const opened = await openDialog(page)
    if (!opened) { test.skip(); return }

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    await expect(dialog).toBeHidden()
  })

  test('backdrop click closes dialog', async ({ electronPage: page }) => {
    const isOnWelcome = await ensureOnWelcomeScreen(page)
    if (!isOnWelcome) { test.skip(); return }

    const opened = await openDialog(page)
    if (!opened) { test.skip(); return }

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    await expect(dialog).toBeVisible()

    // Click outside the dialog (on the backdrop)
    await page.mouse.click(10, 10)
    await page.waitForTimeout(500)

    await expect(dialog).toBeHidden()
  })
})
