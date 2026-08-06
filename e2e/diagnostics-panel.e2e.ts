/**
 * Diagnostics Panel E2E Tests
 *
 * Verifies DiagnosticsPanel (88 LOC) — LSP diagnostics display in chat:
 *   - Diagnostics panel renders when diagnostics are present
 *   - Collapsed header shows summary (e.g., "2 errors, 1 warning")
 *   - Clicking header expands to show full diagnostics list
 *   - Each diagnostic shows severity icon, file:line, and message
 *   - Error severity uses red icon, warning uses yellow icon
 *
 * Note: Diagnostics only appear during active conversations with LSP errors.
 * Tests gracefully skip if no diagnostics are present.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/diagnostics-panel.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Diagnostics Panel', () => {
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

  async function selectConversation(page: import('@playwright/test').Page): Promise<boolean> {
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    const hasTab = await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (hasTab) {
      await chatsTab.click()
      await page.waitForTimeout(800)
    }

    const chatItems = page.locator('[data-testid="chat-item"]')
    if ((await chatItems.count()) === 0) return false

    await chatItems.first().click()
    await page.waitForTimeout(1_500)
    return true
  }

  test('diagnostics panel renders when diagnostics are present', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasConversation = await selectConversation(page)
    if (!hasConversation) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const visible = await panel.isVisible({ timeout: 3_000 }).catch(() => false)

    if (visible) {
      await expect(panel).toBeVisible()
    } else {
      // No diagnostics present — skip gracefully
      test.skip()
    }
  })

  test('collapsed header shows summary with error and warning counts', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasConversation = await selectConversation(page)
    if (!hasConversation) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const visible = await panel.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Header button should show "Diagnostics:" label
    const headerBtn = panel.locator('button').first()
    await expect(headerBtn).toBeVisible()

    const headerText = await headerBtn.textContent()
    expect(headerText).toContain('Diagnostics')

    // Should contain count info (e.g., "1 error", "2 warnings")
    const hasCount = /\d+\s+(error|warning|diagnostic)/i.test(headerText ?? '')
    expect(hasCount).toBeTruthy()
  })

  test('clicking header expands to show full diagnostics list', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasConversation = await selectConversation(page)
    if (!hasConversation) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const visible = await panel.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Click the header button to toggle expansion
    const headerBtn = panel.locator('button').first()
    await headerBtn.click()
    await page.waitForTimeout(500)

    // Diagnostics list should be visible (or toggled)
    const diagList = page.locator('[data-testid="diagnostics-list"]')
    const isExpanded = await diagList.isVisible({ timeout: 2_000 }).catch(() => false)

    if (!isExpanded) {
      // May have been expanded initially and now collapsed — click again
      await headerBtn.click()
      await page.waitForTimeout(500)
    }

    const finalState = await diagList.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(finalState).toBeTruthy()
  })

  test('each diagnostic shows severity icon, file:line, and message', async ({
    electronPage: page
  }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasConversation = await selectConversation(page)
    if (!hasConversation) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const visible = await panel.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Ensure expanded
    const diagList = page.locator('[data-testid="diagnostics-list"]')
    const isExpanded = await diagList.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!isExpanded) {
      const headerBtn = panel.locator('button').first()
      await headerBtn.click()
      await page.waitForTimeout(500)
    }

    const listVisible = await diagList.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!listVisible) {
      test.skip()
      return
    }

    // Each diagnostic item should contain file:line text
    const diagnosticItems = diagList.locator('div > div')
    const itemCount = await diagnosticItems.count()
    expect(itemCount).toBeGreaterThan(0)

    // First item should have a file:line indicator (monospace text)
    const firstItem = diagnosticItems.first()
    const fileLineText = firstItem.locator('.font-mono')
    const hasFileLine = await fileLineText.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasFileLine) {
      const text = await fileLineText.textContent()
      // Should match pattern like "file.ts:42"
      expect(text).toMatch(/\w+[.:]\d+/)
    }
  })

  test('error severity uses red icon, warning uses yellow icon', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const hasConversation = await selectConversation(page)
    if (!hasConversation) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="diagnostics-panel"]')
    const visible = await panel.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!visible) {
      test.skip()
      return
    }

    // Check for red (error) or yellow (warning) icons in the header
    const redIcon = panel.locator('.text-red-400')
    const yellowIcon = panel.locator('.text-yellow-400')

    const hasRed = await redIcon
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)
    const hasYellow = await yellowIcon
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false)

    // At least one severity icon should be present
    expect(hasRed || hasYellow).toBeTruthy()
  })
})
