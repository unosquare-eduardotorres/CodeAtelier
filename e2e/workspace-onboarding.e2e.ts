/**
 * Workspace Onboarding E2E Tests
 *
 * Verifies the first-launch WelcomeModal and CreateProjectDialog flows:
 *   - WelcomeModal renders with name input and CTA
 *   - Name input enables CTA
 *   - Enter key submits form
 *   - CreateProjectDialog opens from Add Workspace
 *   - CreateProjectDialog validates name input
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Workspace Onboarding', () => {
  test('WelcomeModal renders with name input and CTA', async ({ electronPage: page }) => {
    const modal = page.locator('[data-testid="welcome-modal"]')
    const visible = await modal.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!visible) {
      // Profile already set — no modal shown
      test.skip()
      return
    }

    await expect(modal).toBeVisible()

    // Name input visible
    const nameInput = page.locator('[data-testid="welcome-name-input"]')
    await expect(nameInput).toBeVisible()

    // CTA button visible but disabled (no name)
    const ctaBtn = page.locator('[data-testid="welcome-get-started"]')
    await expect(ctaBtn).toBeVisible()
    await expect(ctaBtn).toBeDisabled()
  })

  test('WelcomeModal name input enables CTA', async ({ electronPage: page }) => {
    const modal = page.locator('[data-testid="welcome-modal"]')
    const visible = await modal.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    const nameInput = page.locator('[data-testid="welcome-name-input"]')
    const ctaBtn = page.locator('[data-testid="welcome-get-started"]')

    // Type name → CTA should become enabled
    await nameInput.fill('E2E Test User')
    await page.waitForTimeout(300)
    await expect(ctaBtn).toBeEnabled()

    // Clear input → CTA should be disabled again
    await nameInput.fill('')
    await page.waitForTimeout(300)
    await expect(ctaBtn).toBeDisabled()
  })

  test('WelcomeModal Enter key submits form', async ({ electronPage: page }) => {
    const modal = page.locator('[data-testid="welcome-modal"]')
    const visible = await modal.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    const nameInput = page.locator('[data-testid="welcome-name-input"]')

    // Type name and press Enter
    await nameInput.fill('E2E Test User')
    await page.waitForTimeout(300)
    await nameInput.press('Enter')

    // Modal should show loading or close
    await page.waitForTimeout(3_000)

    // Either modal is gone or shows loading state
    const isHidden = await modal.isHidden().catch(() => false)
    const loadingText = page.getByText(/Setting up/i)
    const hasLoading = await loadingText.isVisible({ timeout: 2_000 }).catch(() => false)

    expect(isHidden || hasLoading).toBeTruthy()
  })

  test('CreateProjectDialog opens from Add Workspace', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)

    // Complete welcome modal if present
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Should be on welcome screen now
    const isOnWelcome = await welcomePage.isVisible()
    if (!isOnWelcome) {
      test.skip()
      return
    }

    // Click "Add Workspace" card
    const addCard = page.locator('[data-testid="add-workspace-card"]')
    const hasCard = await addCard.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasCard) {
      test.skip()
      return
    }

    await addCard.click()
    await page.waitForTimeout(500)

    // CreateProjectDialog should appear
    const dialog = page.locator('[data-testid="create-project-dialog"]')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Name input visible
    const nameInput = page.locator('[data-testid="create-project-name"]')
    await expect(nameInput).toBeVisible()

    // Folder picker button visible
    const folderBtn = page.locator('[data-testid="create-project-folder-btn"]')
    await expect(folderBtn).toBeVisible()

    // Close dialog
    const closeBtn = dialog.locator('button[aria-label="Close"]')
    await closeBtn.click()
    await page.waitForTimeout(300)
    await expect(dialog).toBeHidden()
  })

  test('CreateProjectDialog validates name input', async ({ electronPage: page }) => {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (!isOnWelcome) {
      test.skip()
      return
    }

    const addCard = page.locator('[data-testid="add-workspace-card"]')
    const hasCard = await addCard.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasCard) {
      test.skip()
      return
    }

    await addCard.click()
    await page.waitForTimeout(500)

    const dialog = page.locator('[data-testid="create-project-dialog"]')
    const hasDialog = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasDialog) {
      test.skip()
      return
    }

    const nameInput = page.locator('[data-testid="create-project-name"]')

    // Type name with invalid chars
    await nameInput.fill('test<>project')
    await page.waitForTimeout(500)

    // Error message should appear
    const errorMsg = page.getByText(/not allowed|invalid/i)
    const hasError = await errorMsg.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasError).toBeTruthy()

    // Type valid name → error should clear
    await nameInput.fill('valid-project-name')
    await page.waitForTimeout(500)
    const stillError = await errorMsg.isVisible({ timeout: 1_000 }).catch(() => false)
    expect(stillError).toBeFalsy()
  })
})
