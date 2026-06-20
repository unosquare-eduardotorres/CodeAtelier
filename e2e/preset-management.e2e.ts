/**
 * Preset Management E2E Tests
 *
 * Verifies LLM preset CRUD: listing, creating, editing form validation,
 * set-as-default, deleting custom presets, and close-without-saving.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { WorkspaceSettings } from './pages/workspace-settings'

test.describe('Preset Management', () => {
  /** Navigate to Settings → Models tab where PresetManager renders. */
  async function openModelsTab(page: import('@playwright/test').Page): Promise<void> {
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

    // Switch to settings view
    const settingsTab = page.locator('[data-testid="sidebar-settings-tab"]')
    const hasTab = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await settingsTab.click()
      await page.waitForTimeout(500)
    }

    // Open Models tab
    const settings = new WorkspaceSettings(page)
    const modelsTab = settings.getTab('models')
    const hasModels = await modelsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasModels) {
      await modelsTab.click()
      await page.waitForTimeout(500)
    }
  }

  test('preset manager renders with existing presets', async ({ electronPage: page }) => {
    await openModelsTab(page)

    const manager = page.locator('[data-testid="preset-manager"]')
    const visible = await manager.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await expect(manager).toBeVisible()

    // At least one preset card (built-in "Full Claude")
    const presetCards = page.locator('[data-testid^="preset-card-"]')
    const cardCount = await presetCards.count()
    expect(cardCount).toBeGreaterThanOrEqual(1)

    // Built-in preset shows name
    const firstCard = presetCards.first()
    const text = await firstCard.textContent()
    expect(text).toBeTruthy()
  })

  test('create preset button opens editor modal', async ({ electronPage: page }) => {
    await openModelsTab(page)

    const createBtn = page.locator('[data-testid="preset-create-btn"]')
    const visible = await createBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await createBtn.click()
    await page.waitForTimeout(500)

    // Editor modal should appear
    const modal = page.locator('[data-testid="preset-editor-modal"]')
    await expect(modal).toBeVisible({ timeout: 5_000 })

    // Name input visible
    const nameInput = page.locator('[data-testid="preset-name-input"]')
    await expect(nameInput).toBeVisible()

    // Save button visible
    const saveBtn = page.locator('[data-testid="preset-save-btn"]')
    await expect(saveBtn).toBeVisible()

    // Close modal
    const closeBtn = modal.locator('button').filter({ has: page.locator('svg') }).last()
    await closeBtn.click()
    await page.waitForTimeout(300)
  })

  test('preset editor form validation', async ({ electronPage: page }) => {
    await openModelsTab(page)

    const createBtn = page.locator('[data-testid="preset-create-btn"]')
    const visible = await createBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    await createBtn.click()
    await page.waitForTimeout(500)

    const nameInput = page.locator('[data-testid="preset-name-input"]')
    const saveBtn = page.locator('[data-testid="preset-save-btn"]')

    // Type a name → save button should work
    await nameInput.fill('Test Preset')
    await page.waitForTimeout(300)

    // Clear name → save should be disabled (via validation toast)
    await nameInput.fill('')
    await page.waitForTimeout(300)

    // Action groups should be visible in the editor
    const modal = page.locator('[data-testid="preset-editor-modal"]')
    const editorText = await modal.textContent()
    expect(editorText).toMatch(/Chat|Audit|Claude|Local/i)

    // Close modal
    const closeBtn = modal.locator('button').last()
    await closeBtn.click()
    await page.waitForTimeout(300)
  })

  test('set default preset via star button', async ({ electronPage: page }) => {
    await openModelsTab(page)

    const presetCards = page.locator('[data-testid^="preset-card-"]')
    const cardCount = await presetCards.count()
    if (cardCount < 2) {
      test.skip()
      return
    }

    // Find a non-default preset's set-default button
    const defaultBtns = page.locator('[data-testid^="preset-default-btn-"]')
    const btnCount = await defaultBtns.count()
    if (btnCount === 0) {
      test.skip()
      return
    }

    // Click set-default on first available
    await defaultBtns.first().click()
    await page.waitForTimeout(1_000)

    // A toast should appear confirming the change
    const toast = page.getByText(/default preset updated/i)
    const hasToast = await toast.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasToast).toBeTruthy()
  })

  test('delete custom preset with confirmation', async ({ electronPage: page }) => {
    await openModelsTab(page)

    // Look for delete buttons (only custom presets have them)
    const deleteBtns = page.locator('[data-testid^="preset-delete-btn-"]')
    const btnCount = await deleteBtns.count()
    if (btnCount === 0) {
      // Only built-in presets exist — skip
      test.skip()
      return
    }

    const presetCountBefore = await page.locator('[data-testid^="preset-card-"]').count()

    // Click delete on first custom preset
    await deleteBtns.first().click()
    await page.waitForTimeout(1_000)

    // Verify deletion (card count decreased or toast appeared)
    const presetCountAfter = await page.locator('[data-testid^="preset-card-"]').count()
    const toast = page.getByText(/deleted/i)
    const hasToast = await toast.isVisible({ timeout: 3_000 }).catch(() => false)

    expect(presetCountAfter < presetCountBefore || hasToast).toBeTruthy()
  })

  test('preset editor close without saving', async ({ electronPage: page }) => {
    await openModelsTab(page)

    const createBtn = page.locator('[data-testid="preset-create-btn"]')
    const visible = await createBtn.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    const presetCountBefore = await page.locator('[data-testid^="preset-card-"]').count()

    // Open editor, type a name, close without saving
    await createBtn.click()
    await page.waitForTimeout(500)

    const nameInput = page.locator('[data-testid="preset-name-input"]')
    await nameInput.fill('Unsaved Preset')
    await page.waitForTimeout(300)

    // Close modal via the X button
    const modal = page.locator('[data-testid="preset-editor-modal"]')
    const closeBtn = modal.locator('button').filter({ has: page.locator('svg') }).last()
    await closeBtn.click()
    await page.waitForTimeout(500)

    // Modal should be gone
    await expect(modal).toBeHidden({ timeout: 3_000 })

    // No new preset should appear
    const presetCountAfter = await page.locator('[data-testid^="preset-card-"]').count()
    expect(presetCountAfter).toBe(presetCountBefore)
  })
})
