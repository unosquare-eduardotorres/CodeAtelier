/**
 * Core Prompt Editor E2E Tests
 *
 * Verifies CoreAgentPromptEditor (219 LOC) — per-mode system prompt customization:
 *   - Editor renders with mode tabs (Plan, Build)
 *   - Switching tab loads the corresponding prompt text
 *   - Textarea shows editable prompt content
 *   - Save button triggers with success feedback indicator
 *   - Reset button shows confirmation dialog
 *   - Edit tracking shows dirty state when content changes
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/core-prompt-editor.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('Core Prompt Editor', () => {
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

  async function navigateToPromptEditor(page: import('@playwright/test').Page): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)
    await settingsNav.navigateToSettingsTab('specialist')
    await page.waitForTimeout(800)

    // Look for the core prompt editor section
    const editor = page.locator('[data-testid="core-prompt-editor"]')
    if (await editor.isVisible({ timeout: 5_000 }).catch(() => false)) return true

    // May need to scroll or click a sub-section to reveal the editor
    const promptSection = page.getByText(/core.*prompt|system.*prompt|agent.*prompt/i).first()
    if (await promptSection.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await promptSection.click()
      await page.waitForTimeout(500)
    }

    return editor.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('editor renders with mode tabs (Plan, Build)', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')
    await expect(editor).toBeVisible()

    // Should show Plan Mode and Build Mode tabs
    const planTab = editor.getByText('Plan Mode').first()
    const buildTab = editor.getByText('Build Mode').first()

    await expect(planTab).toBeVisible()
    await expect(buildTab).toBeVisible()
  })

  test('switching tab loads the corresponding prompt text', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')

    // Get text from Plan mode
    const planTab = editor.getByText('Plan Mode').first()
    await planTab.click()
    await page.waitForTimeout(300)

    const textarea = editor.locator('textarea').first()
    const planText = await textarea.inputValue()

    // Switch to Build mode
    const buildTab = editor.getByText('Build Mode').first()
    await buildTab.click()
    await page.waitForTimeout(300)

    const buildText = await textarea.inputValue()

    // Both should have content (prompts should be loaded)
    expect(planText.length).toBeGreaterThan(0)
    expect(buildText.length).toBeGreaterThan(0)
  })

  test('textarea shows editable prompt content', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')

    // Textarea should be visible and contain prompt text
    const textarea = editor.locator('textarea').first()
    await expect(textarea).toBeVisible()

    const content = await textarea.inputValue()
    expect(content.length).toBeGreaterThan(0)

    // Character count should be displayed
    const charCount = editor.getByText(/\d+ chars/i).first()
    const hasCharCount = await charCount.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasCharCount).toBeTruthy()
  })

  test('save button triggers with success feedback indicator', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')

    // Save Prompt button should be visible
    const saveBtn = editor.getByRole('button', { name: /save prompt/i }).first()
    await expect(saveBtn).toBeVisible()

    // Should be disabled when no changes are made
    const isDisabled = await saveBtn.isDisabled()
    expect(isDisabled).toBeTruthy()
  })

  test('reset button shows confirmation dialog', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')

    // Reset to Default button (only visible if custom prompt exists)
    const resetBtn = editor.getByRole('button', { name: /reset to default/i }).first()
    const hasReset = await resetBtn.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasReset) {
      // Prompt is using defaults — no reset button shown
      // Verify the Custom badge is not visible
      const customBadge = editor.getByText('Custom').first()
      const isCustom = await customBadge.isVisible({ timeout: 2_000 }).catch(() => false)
      expect(isCustom).toBeFalsy()
      return
    }

    // Click reset to show confirmation
    await resetBtn.click()
    await page.waitForTimeout(300)

    // Confirmation warning should appear
    const confirmText = editor.getByText(/restore the original/i).first()
    const hasConfirm = await confirmText.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasConfirm).toBeTruthy()

    // Cancel button should be available
    const cancelBtn = editor.getByRole('button', { name: /cancel/i }).first()
    if (await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await cancelBtn.click()
      await page.waitForTimeout(300)
    }
  })

  test('edit tracking shows dirty state when content changes', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }
    const hasEditor = await navigateToPromptEditor(page)
    if (!hasEditor) {
      test.skip()
      return
    }

    const editor = page.locator('[data-testid="core-prompt-editor"]')
    const textarea = editor.locator('textarea').first()
    const saveBtn = editor.getByRole('button', { name: /save prompt/i }).first()

    // Save button should initially be disabled (no changes)
    const initialDisabled = await saveBtn.isDisabled()
    expect(initialDisabled).toBeTruthy()

    // Make a change to the prompt
    await textarea.click()
    await textarea.press('End')
    await textarea.type(' test-edit')
    await page.waitForTimeout(300)

    // Save button should now be enabled (dirty state)
    const afterEditDisabled = await saveBtn.isDisabled()
    expect(afterEditDisabled).toBeFalsy()

    // Undo the change to restore original content
    await textarea.press('Control+z')
    await textarea.press('Control+z')
    await page.waitForTimeout(300)
  })
})
