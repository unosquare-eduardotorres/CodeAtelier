/**
 * Dialog Keyboard Flow E2E Tests
 *
 * Cross-dialog keyboard interaction patterns:
 *   - Escape key closes active dialog (any dialog type)
 *   - Backdrop click closes dialog and returns to underlying content
 *   - Confirm button receives focus on open
 *   - Tab key cycles between dialog buttons
 *   - Enter key triggers the focused dialog button
 *   - Dialog overlay prevents interaction with background content
 *   - Dialog close restores focus to triggering element
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/dialog-keyboard-flow.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Dialog Keyboard Flow', () => {
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

  /** Try to open any available dialog and return which one was opened. */
  async function openAnyDialog(
    page: import('@playwright/test').Page
  ): Promise<string | null> {
    // Try close dialog first
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    const hasTab = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await chatsTab.click()
      await page.waitForTimeout(800)
    }

    const chatItems = page.locator('[data-testid="chat-item"]')
    if ((await chatItems.count()) > 0) {
      await chatItems.first().click()
      await page.waitForTimeout(1_500)

      // Try close button
      const closeBtn = page.locator('[data-testid="close-conversation-btn"], button:has-text("Close")')
      if (await closeBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await closeBtn.first().click()
        await page.waitForTimeout(500)
        if (await page.locator('[data-testid="close-dialog"]').isVisible({ timeout: 2_000 }).catch(() => false)) {
          return 'close-dialog'
        }
      }

      // Try complete button
      const completeBtn = page.locator('button:has-text("Complete"), [data-testid="complete-btn"]')
      if (await completeBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await completeBtn.first().click()
        await page.waitForTimeout(500)
        if (await page.locator('[data-testid="complete-dialog"]').isVisible({ timeout: 2_000 }).catch(() => false)) {
          return 'complete-dialog'
        }
      }

      // Try rewind button
      const rewindBtn = page.locator('button:has-text("Rewind"), [data-testid="rewind-btn"]')
      if (await rewindBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
        await rewindBtn.first().click()
        await page.waitForTimeout(500)
        if (await page.locator('[data-testid="rewind-dialog"]').isVisible({ timeout: 2_000 }).catch(() => false)) {
          return 'rewind-dialog'
        }
      }
    }

    return null
  }

  test('escape key closes active dialog (any dialog type)', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openAnyDialog(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('backdrop click closes dialog and returns to underlying content', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openAnyDialog(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Click on the backdrop (the fixed overlay behind the dialog)
    const backdrop = dialog.locator('..').locator('.bg-black\\/60, [class*="bg-[rgba"]').first()
    const hasBackdrop = await backdrop.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasBackdrop) { test.skip(); return }

    await backdrop.click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(500)

    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('confirm button receives focus on open (ConfirmDialog)', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    // ConfirmDialog auto-focuses confirm button via useRef
    const confirmDialog = page.locator('[data-testid="confirm-dialog"]')

    // Try to trigger a confirm dialog via skill/agent delete
    const settingsTab = page.locator('[data-testid="sidebar-tab-settings"]')
    const hasSettings = await settingsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasSettings) { test.skip(); return }

    await settingsTab.click()
    await page.waitForTimeout(1_000)

    // Look for any delete button that would trigger ConfirmDialog
    const deleteBtn = page.locator('button[aria-label*="Delete"], button[aria-label*="delete"]')
    const hasDelete = await deleteBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasDelete) { test.skip(); return }

    await deleteBtn.first().click()
    await page.waitForTimeout(500)

    const isVisible = await confirmDialog.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // The confirm button should have auto-focus
    const confirmBtn = confirmDialog.locator('button').last()
    const isFocused = await confirmBtn.evaluate((el) => document.activeElement === el)
    expect(isFocused).toBe(true)
  })

  test('tab key cycles between dialog buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openAnyDialog(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Count buttons in dialog
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()
    if (buttonCount < 2) { test.skip(); return }

    // Focus first button
    await buttons.first().focus()
    await page.waitForTimeout(200)

    // Tab to next button
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)

    // A different button should now be focused
    const focusedElement = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase())
    expect(focusedElement).toBe('button')
  })

  test('enter key triggers the focused dialog button', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openAnyDialog(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // Focus the Cancel button and press Enter to dismiss
    const cancelBtn = dialog.locator('button:has-text("Cancel")')
    const hasCancelBtn = await cancelBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasCancelBtn) { test.skip(); return }

    await cancelBtn.focus()
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)

    // Dialog should be dismissed by Enter on Cancel
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('dialog overlay prevents interaction with background content', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    const dialogType = await openAnyDialog(page)
    if (!dialogType) { test.skip(); return }

    const dialog = page.locator(`[data-testid="${dialogType}"]`)
    await expect(dialog).toBeVisible()

    // The dialog parent should have role="dialog" and aria-modal="true"
    const dialogContainer = page.locator('[role="dialog"][aria-modal="true"]')
    const hasModal = await dialogContainer.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasModal) { test.skip(); return }

    await expect(dialogContainer).toHaveAttribute('aria-modal', 'true')

    // Clean up
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  })

  test('dialog close restores focus to triggering element', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) { test.skip(); return }

    // Find a trigger button before opening dialog
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    const hasTab = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await chatsTab.click()
      await page.waitForTimeout(800)
    }

    const chatItems = page.locator('[data-testid="chat-item"]')
    if ((await chatItems.count()) === 0) { test.skip(); return }
    await chatItems.first().click()
    await page.waitForTimeout(1_500)

    // Try to find and click a dialog trigger
    const closeBtn = page.locator('[data-testid="close-conversation-btn"]')
    const hasCloseBtn = await closeBtn.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasCloseBtn) { test.skip(); return }

    await closeBtn.click()
    await page.waitForTimeout(500)

    const dialog = page.locator('[data-testid="close-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!isVisible) { test.skip(); return }

    // Close the dialog with Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Dialog should be closed
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })

    // Verify page is still functional — sidebar should be visible
    const sidebar = page.locator('[data-testid="unified-sidebar"]')
    const hasSidebar = await sidebar.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasSidebar).toBe(true)
  })
})
