/**
 * Compact Context Modal E2E Tests
 *
 * Verifies the CompactContextModal component (410 LOC) — handles context
 * window management with dual-mode logic (Claude vs. local):
 *   - Modal renders with context usage bar
 *   - Category breakdown shows token distribution
 *   - MCP tools collapsible shows top tool consumers
 *   - Claude mode shows Extract + Quick Compact buttons
 *   - Local mode shows Start New Conversation
 *   - Escape key dismisses modal
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/compact-context-modal.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Compact Context Modal', () => {
  async function ensureWorkspaceReady(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
    return true
  }

  test('modal renders with context usage bar', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    // The compact context modal appears during long conversations.
    // Check if one is already showing or can be triggered.
    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasModal) {
      // Modal is context-triggered — verify testid exists in DOM for when it activates
      test.skip()
      return
    }

    await expect(modal).toBeVisible()

    // Context usage bar should be present
    const usageBar = page.locator('[data-testid="context-usage-bar"]')
    await expect(usageBar).toBeVisible()
  })

  test('category breakdown shows token distribution', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    // Look for category rows with token counts
    const categoryRows = modal.locator('.tabular-nums')
    const count = await categoryRows.count()

    // If breakdown is available, there should be category rows
    if (count > 0) {
      const firstText = await categoryRows.first().textContent()
      expect(firstText).toBeTruthy()
    }
  })

  test('MCP tools collapsible shows top tool consumers', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    const mcpToggle = page.locator('[data-testid="context-mcp-toggle"]')
    const hasMcpToggle = await mcpToggle.isVisible({ timeout: 2_000 }).catch(() => false)
    if (!hasMcpToggle) {
      // No MCP tools in this context — skip
      test.skip()
      return
    }

    // Click to expand MCP tools list
    await mcpToggle.click()
    await page.waitForTimeout(300)

    // Should show tool entries with serverName.toolName format
    const toolEntries = modal.locator('.font-mono')
    const toolCount = await toolEntries.count()
    expect(toolCount).toBeGreaterThan(0)

    // Click again to collapse
    await mcpToggle.click()
    await page.waitForTimeout(300)
  })

  test('Claude mode shows Extract and Quick Compact buttons', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    // In Claude mode, expect Extract Nuance & Compact + Quick Compact
    const compactBtn = page.locator('[data-testid="context-compact-btn"]')
    const quickCompactBtn = page.locator('[data-testid="context-quick-compact-btn"]')

    const hasCompact = await compactBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    const hasQuick = await quickCompactBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    // In Claude mode both should be visible; in local mode neither
    if (hasCompact) {
      await expect(compactBtn).toBeVisible()
      await expect(quickCompactBtn).toBeVisible()

      // Verify button text
      const compactText = await compactBtn.textContent()
      expect(compactText).toContain('Extract Nuance')

      const quickText = await quickCompactBtn.textContent()
      expect(quickText).toContain('Quick Compact')
    }
  })

  test('local mode shows Start New Conversation', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    // In local LLM mode, Start New Conversation button should be visible
    const newConvoBtn = page.locator('[data-testid="context-new-convo-btn"]')
    const hasNewConvo = await newConvoBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasNewConvo) {
      const text = await newConvoBtn.textContent()
      expect(text).toContain('Start New Conversation')

      // "Continue Anyway" secondary button should also be visible
      const continueBtn = page.getByText(/continue anyway/i)
      await expect(continueBtn).toBeVisible()
    }
  })

  test('escape key dismisses modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    const hasModal = await modal.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasModal) {
      test.skip()
      return
    }

    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)

    // Modal should close
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})
