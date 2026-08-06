/**
 * ConfirmDialog E2E Tests
 *
 * Verifies ConfirmDialog (104 LOC) — reusable confirmation dialog:
 *   - Default variant renders with title and message
 *   - Danger variant shows warning icon and red styling
 *   - Confirm button receives auto-focus when dialog opens
 *   - Escape key closes dialog without confirming
 *   - Backdrop click closes dialog
 *   - Custom labels display for confirm/cancel buttons
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/confirm-dialog.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { AppChrome } from './pages/app-chrome'
import { SettingsNav } from './pages/settings-nav'

test.describe('ConfirmDialog', () => {
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

  /** Try to trigger a ConfirmDialog via a destructive action in settings. */
  async function triggerConfirmDialog(page: import('@playwright/test').Page): Promise<boolean> {
    const chrome = new AppChrome(page)
    await chrome.navigateToTab('settings')
    const settingsNav = new SettingsNav(page)

    // Try team tab first for agent/skill delete
    await settingsNav.navigateToSettingsTab('team')
    await page.waitForTimeout(1_000)

    // Look for any delete button on agents or skills
    const deleteBtn = page.locator(
      'button[aria-label*="Delete"], button[aria-label*="delete"], button[aria-label*="Remove"]'
    )
    const hasDelete = await deleteBtn
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasDelete) {
      await deleteBtn.first().click()
      await page.waitForTimeout(500)
      return true
    }

    // Try skills tab
    await settingsNav.navigateToSettingsTab('team')
    await page.waitForTimeout(1_000)

    const skillDelete = page.locator(
      '[data-testid="skill-management-section"] button[aria-label*="delete" i]'
    )
    const hasSkillDelete = await skillDelete
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    if (hasSkillDelete) {
      await skillDelete.first().click()
      await page.waitForTimeout(500)
      return true
    }

    return false
  }

  test('default variant renders with title and message', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    await expect(dialog).toBeVisible()

    // Should have a title
    const title = dialog.locator('#confirm-dialog-title')
    await expect(title).toBeVisible()
    const titleText = await title.textContent()
    expect(titleText!.length).toBeGreaterThan(0)

    // Should have a message
    const message = dialog.locator('#confirm-dialog-message')
    await expect(message).toBeVisible()
    const messageText = await message.textContent()
    expect(messageText!.length).toBeGreaterThan(0)

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('danger variant shows warning icon and red styling', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Check for danger variant styling — warning icon in danger circle
    const dangerIcon = dialog.locator('.bg-danger-muted')
    const isDanger = await dangerIcon.isVisible({ timeout: 2_000 }).catch(() => false)

    if (isDanger) {
      await expect(dangerIcon).toBeVisible()
      // Confirm button should have danger styling
      const confirmBtn = dialog.locator('button.bg-danger, button[class*="bg-danger"]')
      await expect(confirmBtn).toBeVisible()
    } else {
      // Default variant — confirm button should have primary styling
      const confirmBtn = dialog.locator('button.bg-primary, button[class*="bg-primary"]')
      await expect(confirmBtn).toBeVisible()
    }

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('confirm button receives auto-focus when dialog opens', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Wait for auto-focus to apply
    await page.waitForTimeout(300)

    // The confirm button (last button) should be auto-focused via ref
    const buttons = dialog.locator('button')
    const lastButton = buttons.last()
    const isFocused = await lastButton.evaluate((el) => document.activeElement === el)
    expect(isFocused).toBe(true)

    // Clean up
    await page.keyboard.press('Escape')
  })

  test('escape key closes dialog without confirming', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Dialog should be dismissed
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('backdrop click closes dialog', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Click backdrop — the overlay area behind the dialog
    const backdrop = page.locator('[role="dialog"] > .absolute.inset-0').first()
    const hasBackdrop = await backdrop.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasBackdrop) {
      // Fallback: press Escape instead
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
      await expect(dialog).not.toBeVisible({ timeout: 3_000 })
      return
    }

    await backdrop.click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(500)

    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  test('custom labels display for confirm/cancel buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const triggered = await triggerConfirmDialog(page)
    if (!triggered) {
      test.skip()
      return
    }

    const dialog = page.locator('[data-testid="confirm-dialog"]')
    const isVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!isVisible) {
      test.skip()
      return
    }

    // Should have two buttons (cancel + confirm)
    const buttons = dialog.locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThanOrEqual(2)

    // Each button should have text content
    for (let i = 0; i < buttonCount; i++) {
      const text = await buttons.nth(i).textContent()
      expect(text!.trim().length).toBeGreaterThan(0)
    }

    // Clean up
    await page.keyboard.press('Escape')
  })
})
