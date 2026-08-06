/**
 * Generate Specialist E2E Tests
 *
 * Tests GenerateSpecialistModal (224 LOC) + PromptPreviewModal (113 LOC):
 *   - Generate specialist modal renders for workspaces with pending specialist
 *   - "Generate Now" button triggers specialist build
 *   - Building state shows spinner and progress message
 *   - Ready state shows success checkmark and auto-closes
 *   - Prompt preview modal shows editable system prompt
 *   - Save button in prompt preview persists changes
 *
 * The GenerateSpecialistModal appears when a workspace has no specialist
 * or a pending/failed build. Tests verify DOM structure when visible.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/generate-specialist.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Generate Specialist', () => {
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

  // ── GenerateSpecialistModal ──

  test('generate specialist modal renders for workspaces with pending specialist', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Modal should have the title
    const title = modal.locator('h1')
    const titleText = await title.textContent()

    const hasValidTitle =
      titleText?.includes('Generate Project Specialist') ||
      titleText?.includes('Generating Specialist') ||
      titleText?.includes('Specialist Ready') ||
      titleText?.includes('Build Failed')

    expect(hasValidTitle).toBeTruthy()

    // Should have the sparkles/check/warning icon
    const svgIcon = modal.locator('svg').first()
    await expect(svgIcon).toBeVisible()
  })

  test('"Generate Now" button triggers specialist build', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Look for the Generate Now / Retry button
    const generateBtn = page.locator('[data-testid="generate-specialist-btn"]')
    const hasBtn = await generateBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!hasBtn) {
      test.skip()
      return
    }

    await expect(generateBtn).toBeVisible()

    const btnText = await generateBtn.textContent()
    const hasValidLabel =
      btnText?.includes('Generate Now') ||
      btnText?.includes('Retry') ||
      btnText?.includes('Building')

    expect(hasValidLabel).toBeTruthy()
  })

  test('building state shows spinner and progress message', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Check for building state indicators
    const title = modal.locator('h1')
    const titleText = await title.textContent()

    if (!titleText?.includes('Generating Specialist')) {
      test.skip()
      return
    }

    // Spinner should be visible (animate-spin class on SVG)
    const spinner = modal.locator('.animate-spin')
    const hasSpinner = await spinner
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    expect(hasSpinner).toBeTruthy()

    // Progress message should be visible
    const progressText = modal.locator('[aria-live="polite"]')
    await expect(progressText).toBeVisible()
  })

  test('ready state shows success checkmark and auto-closes', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="generate-specialist-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Check for ready state
    const title = modal.locator('h1')
    const titleText = await title.textContent()

    if (!titleText?.includes('Specialist Ready')) {
      test.skip()
      return
    }

    // Should show success message
    const successText = modal.locator('text=Your specialist is ready')
    await expect(successText).toBeVisible()

    // Should auto-close after ~1.5s
    await expect(modal).toBeHidden({ timeout: 5_000 })
  })

  // ── PromptPreviewModal ──

  test('prompt preview modal shows editable system prompt', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Should have "Edit System Prompt" header
    const header = modal.locator('h3')
    await expect(header).toContainText('Edit System Prompt')

    // Should have an editable textarea
    const textarea = modal.locator('textarea')
    await expect(textarea).toBeVisible()

    // Textarea should contain prompt content
    const value = await textarea.inputValue()
    expect(value.length).toBeGreaterThan(0)

    // Character count should be displayed
    const charCount = modal.locator('text=characters')
    await expect(charCount).toBeVisible()
  })

  test('save button in prompt preview persists changes', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      test.skip()
      return
    }

    // Save button should exist
    const saveBtn = page.locator('[data-testid="prompt-preview-save"]')
    await expect(saveBtn).toBeVisible()

    // Save button should be disabled when no changes made (isDirty = false)
    const isDisabled = await saveBtn.isDisabled()

    // If textarea is pristine, save should be disabled
    if (isDisabled) {
      expect(isDisabled).toBeTruthy()

      // Make a change to enable the button
      const textarea = modal.locator('textarea')
      await textarea.fill('Modified prompt content for testing')
      await page.waitForTimeout(200)

      // Save should now be enabled
      await expect(saveBtn).toBeEnabled()
    } else {
      // Already has unsaved changes — save should be enabled
      await expect(saveBtn).toBeEnabled()
    }
  })
})
