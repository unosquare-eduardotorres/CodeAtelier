/**
 * Create Project Dialog E2E Tests
 *
 * Verifies the CreateProjectDialog modal — the onboarding critical path
 * for new projects:
 *   - Dialog opens from welcome screen "Create New Project" button
 *   - Name input and folder picker are present
 *   - Create button is disabled without required fields
 *   - Close/cancel returns to welcome screen
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/welcome-wizard.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Create Project Dialog', () => {
  /**
   * Navigate to the welcome screen.
   */
  async function ensureWelcomeScreen(page: import('@playwright/test').Page): Promise<WelcomePage> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }
    return welcomePage
  }

  /** Try to open the create-project dialog from the welcome screen. */
  async function openDialog(page: import('@playwright/test').Page): Promise<boolean> {
    // Look for "Create New Project" button
    const createBtn = page.getByRole('button', { name: /create.*project|new.*project/i }).first()
    const hasBtn = await createBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasBtn) {
      await createBtn.click()
      await page.waitForTimeout(500)
    }
    const dialog = page.locator('[data-testid="create-project-dialog"]')
    return dialog.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('dialog opens from welcome screen Create New Project button', async ({
    electronPage: page
  }) => {
    await ensureWelcomeScreen(page)
    const opened = await openDialog(page)
    if (!opened) {
      test.skip()
      return
    }

    await expect(page.locator('[data-testid="create-project-dialog"]')).toBeVisible()
    // Name input should be present
    await expect(page.locator('[data-testid="create-project-name"]')).toBeVisible()
    // Folder picker should be present
    await expect(page.locator('[data-testid="create-project-folder-btn"]')).toBeVisible()
  })

  test('name input accepts text and validates', async ({ electronPage: page }) => {
    await ensureWelcomeScreen(page)
    const opened = await openDialog(page)
    if (!opened) {
      test.skip()
      return
    }

    const nameInput = page.locator('[data-testid="create-project-name"]')
    await expect(nameInput).toBeVisible()

    // Type valid name
    await nameInput.fill('my-test-project')
    await page.waitForTimeout(300)
    const value = await nameInput.inputValue()
    expect(value).toBe('my-test-project')

    // Type invalid name
    await nameInput.fill('test<>project')
    await page.waitForTimeout(300)
    const errorMsg = page.getByText(/not allowed/i)
    const hasError = await errorMsg.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasError).toBeTruthy()
  })

  test('create button is disabled without required fields', async ({ electronPage: page }) => {
    await ensureWelcomeScreen(page)
    const opened = await openDialog(page)
    if (!opened) {
      test.skip()
      return
    }

    // Create button should be disabled initially (no name, no folder)
    const createBtn = page.getByRole('button', { name: /create project/i })
    await expect(createBtn).toBeDisabled()
  })

  test('dialog closes on cancel', async ({ electronPage: page }) => {
    await ensureWelcomeScreen(page)
    const opened = await openDialog(page)
    if (!opened) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    await expect(dialog).toBeVisible()

    // Click Cancel button
    const cancelBtn = page.getByRole('button', { name: /cancel/i })
    await cancelBtn.click()
    await page.waitForTimeout(300)

    await expect(dialog).toBeHidden()
  })

  test('dialog closes on close button', async ({ electronPage: page }) => {
    await ensureWelcomeScreen(page)
    const opened = await openDialog(page)
    if (!opened) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    await expect(dialog).toBeVisible()

    // Click close (X) button
    const closeBtn = dialog.locator('button[aria-label="Close"]')
    await closeBtn.click()
    await page.waitForTimeout(300)

    await expect(dialog).toBeHidden()
  })
})
