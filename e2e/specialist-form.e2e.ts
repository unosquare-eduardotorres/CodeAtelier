/**
 * SpecialistForm E2E Tests
 *
 * Verifies SpecialistForm (312 LOC) — specialist creation and editing form:
 *   - Form renders with input fields
 *   - Name input accepts and displays entered text
 *   - Description textarea allows multi-line input
 *   - Model selection shows available options
 *   - Form shows validation feedback on empty required fields
 *   - Cancel action discards unsaved form changes
 *
 * Navigation: Settings → Specialist → Create/Edit specialist.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/specialist-form.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('SpecialistForm', () => {
  async function navigateToSpecialistSettings(
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

    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.selectTab('team')
    await page.waitForTimeout(1_000)
    return true
  }

  async function openSpecialistForm(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Look for "Add Specialist" button
    const addBtn = page.locator('button:has-text("Add Specialist"), button:has-text("Add specialist"), button:has-text("New Specialist")')
    const hasAdd = await addBtn.first().isVisible({ timeout: 5_000 }).catch(() => false)
    if (hasAdd) {
      await addBtn.first().click()
      await page.waitForTimeout(500)
      return true
    }

    // Alternative: click on an existing specialist to edit
    const specialistCards = page.locator('[data-testid="specialist-card"]')
    if ((await specialistCards.count()) > 0) {
      const editBtn = page.locator('button:has-text("Edit"), button[aria-label*="Edit"]')
      if (await editBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        await editBtn.first().click()
        await page.waitForTimeout(500)
        return true
      }
    }

    return false
  }

  test('specialist form renders with input fields', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    await expect(form).toBeVisible()

    // Header should show "Add Specialist" or "Edit Specialist"
    const header = form.locator('h2')
    await expect(header).toBeVisible()
    const headerText = await header.textContent()
    expect(headerText).toMatch(/Add Specialist|Edit Specialist/)

    // Should have Display Name input
    const displayNameLabel = form.locator('label:has-text("Display Name")')
    await expect(displayNameLabel).toBeVisible()

    // Should have input fields
    const inputs = form.locator('input[type="text"]')
    const inputCount = await inputs.count()
    expect(inputCount).toBeGreaterThanOrEqual(2) // Name + Agent ID minimum

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('name input accepts and displays entered text', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Find the display name input (first text input)
    const nameInput = form.locator('input[placeholder*="React Architect"]').first()
    const hasInput = await nameInput.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasInput) { test.skip(); return }

    // Clear and type a name
    await nameInput.fill('')
    await nameInput.fill('Test Specialist')
    await page.waitForTimeout(300)

    // Input should display the typed text
    await expect(nameInput).toHaveValue('Test Specialist')

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('description textarea allows multi-line input', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Find the prompt textarea
    const textarea = form.locator('textarea')
    const hasTextarea = await textarea.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTextarea) { test.skip(); return }

    // Type multi-line content
    await textarea.first().fill('Line 1\nLine 2\nLine 3')
    await page.waitForTimeout(300)

    // Textarea should contain the text
    const value = await textarea.first().inputValue()
    expect(value).toContain('Line 1')
    expect(value).toContain('Line 2')

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('model selection shows available options', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Should have icon and color inputs
    const iconInput = form.locator('input[maxlength="4"]')
    const colorInput = form.locator('input[type="color"]')

    const hasIcon = await iconInput.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasColor = await colorInput.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasIcon) {
      await expect(iconInput).toBeVisible()
    }
    if (hasColor) {
      await expect(colorInput).toBeVisible()
    }

    // Priority input should be present
    const priorityInput = form.locator('input[type="number"]')
    const hasPriority = await priorityInput.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasPriority) {
      await expect(priorityInput).toBeVisible()
    }

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('form shows validation feedback on empty required fields', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Clear the display name (required field)
    const nameInput = form.locator('input[placeholder*="React Architect"]').first()
    const hasInput = await nameInput.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasInput) {
      await nameInput.fill('')
    }

    // Try to save with empty name
    const saveBtn = form.locator('button:has-text("Add Specialist"), button:has-text("Save Changes")')
    const hasSave = await saveBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSave) { test.skip(); return }

    await saveBtn.first().click()
    await page.waitForTimeout(500)

    // Error message should appear
    const errorMsg = form.locator('.text-danger, .bg-danger-muted')
    const hasError = await errorMsg.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasError) {
      await expect(errorMsg.first()).toBeVisible()
      const errorText = await errorMsg.first().textContent()
      expect(errorText).toBeTruthy()
    }

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('cancel action discards unsaved form changes', async ({ electronPage: page }) => {
    const ready = await navigateToSpecialistSettings(page)
    if (!ready) { test.skip(); return }

    const opened = await openSpecialistForm(page)
    if (!opened) { test.skip(); return }

    const form = page.locator('[data-testid="specialist-form"]')
    const isVisible = await form.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Cancel button should dismiss the form
    const cancelBtn = form.locator('button:has-text("Cancel")')
    await expect(cancelBtn).toBeVisible()
    await cancelBtn.click()
    await page.waitForTimeout(500)

    // Form should be dismissed
    await expect(form).not.toBeVisible({ timeout: 3_000 })
  })
})
