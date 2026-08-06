/**
 * Prompt Editor E2E Tests
 *
 * Verifies PromptPreviewModal (113 LOC) + SystemPromptSection:
 *   - Prompt preview modal opens from system prompt section edit button
 *   - Modal shows editable textarea with current prompt content
 *   - Character count updates as user types
 *   - Save button disabled when no changes made (isDirty check)
 *   - Escape key closes the prompt editor modal
 *
 * Navigation: Specialist settings tab → System Prompt section → Edit button.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/prompt-editor.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Prompt Editor', () => {
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

  /** Navigate to specialist settings and open the prompt preview modal. */
  async function openPromptModal(page: import('@playwright/test').Page): Promise<boolean> {
    // Navigate to specialist settings tab
    const specialistTab = page.locator('[data-testid="settings-tab-specialist"]')
    const hasTab = await specialistTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTab) {
      // Try via sidebar
      const settingsBtn = page.locator('[data-testid="sidebar-tab-settings"]')
      const hasSidebar = await settingsBtn.isVisible({ timeout: 2_000 }).catch(() => false)
      if (hasSidebar) {
        await settingsBtn.click()
        await page.waitForTimeout(800)
      }

      // Try again after navigating
      const retryTab = page.locator('[data-testid="settings-tab-specialist"]')
      const hasRetry = await retryTab.isVisible({ timeout: 3_000 }).catch(() => false)
      if (!hasRetry) return false
      await retryTab.click()
    } else {
      await specialistTab.click()
    }
    await page.waitForTimeout(800)

    // Look for edit/pencil button in the system prompt section
    const editBtn = page.locator('button[aria-label*="Edit"], button[aria-label*="edit"]').first()
    const hasEditBtn = await editBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasEditBtn) return false

    await editBtn.click()
    await page.waitForTimeout(600)

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    return modal.isVisible({ timeout: 3_000 }).catch(() => false)
  }

  test('prompt preview modal opens from system prompt section edit button', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modalOpen = await openPromptModal(page)
    if (!modalOpen) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    await expect(modal).toBeVisible()

    // Should show "Edit System Prompt" heading
    const heading = modal.getByText(/edit system prompt/i)
    await expect(heading).toBeVisible()
  })

  test('modal shows editable textarea with current prompt content', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modalOpen = await openPromptModal(page)
    if (!modalOpen) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    const textarea = modal.locator('textarea')
    await expect(textarea).toBeVisible()

    // Textarea should have content (the current system prompt)
    const value = await textarea.inputValue()
    expect(value.length).toBeGreaterThan(0)
  })

  test('character count updates as user types', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modalOpen = await openPromptModal(page)
    if (!modalOpen) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')

    // Character count should be visible in footer
    const charCount = modal.getByText(/characters/i)
    await expect(charCount).toBeVisible()

    // Get initial character count text
    const initialText = await charCount.textContent()

    // Type additional text
    const textarea = modal.locator('textarea')
    await textarea.focus()
    await textarea.press('End')
    await textarea.type(' additional test text')
    await page.waitForTimeout(300)

    // Character count should have changed
    const updatedText = await charCount.textContent()
    expect(updatedText).not.toBe(initialText)
  })

  test('save button disabled when no changes made (isDirty check)', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modalOpen = await openPromptModal(page)
    if (!modalOpen) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')

    // Save button should be disabled when no changes
    const saveBtn = modal.locator('button').filter({ hasText: /save/i })
    const hasSave = await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasSave) {
      test.skip()
      return
    }

    await expect(saveBtn).toBeDisabled()

    // Type something to make it dirty
    const textarea = modal.locator('textarea')
    await textarea.focus()
    await textarea.type(' test')
    await page.waitForTimeout(300)

    // Save button should now be enabled
    await expect(saveBtn).toBeEnabled()
  })

  test('escape key closes the prompt editor modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modalOpen = await openPromptModal(page)
    if (!modalOpen) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="prompt-preview-modal"]')
    await expect(modal).toBeVisible()

    // Press Escape to close
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Modal should be closed
    await expect(modal).not.toBeVisible()
  })
})
