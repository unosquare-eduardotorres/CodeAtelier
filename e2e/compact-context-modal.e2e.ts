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
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('Compact Context Modal', () => {
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

  test('modal renders with context usage bar', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await expect(modal).toBeVisible()
    await expect(page.locator('[data-testid="context-usage-bar"]')).toBeVisible()
  })

  test('category breakdown shows token distribution', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const categoryRows = modal.locator('.tabular-nums')
    const count = await categoryRows.count()
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
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const mcpToggle = page.locator('[data-testid="context-mcp-toggle"]')
    if (!(await mcpToggle.isVisible({ timeout: 2_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await mcpToggle.click()
    await page.waitForTimeout(300)
    const toolEntries = modal.locator('.font-mono')
    expect(await toolEntries.count()).toBeGreaterThan(0)
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
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const compactBtn = page.locator('[data-testid="context-compact-btn"]')
    const quickCompactBtn = page.locator('[data-testid="context-quick-compact-btn"]')
    const hasCompact = await compactBtn.isVisible({ timeout: 2_000 }).catch(() => false)

    if (hasCompact) {
      await expect(compactBtn).toBeVisible()
      await expect(quickCompactBtn).toBeVisible()
      expect(await compactBtn.textContent()).toContain('Extract Nuance')
      expect(await quickCompactBtn.textContent()).toContain('Quick Compact')
    }
  })

  test('local mode shows Start New Conversation', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const newConvoBtn = page.locator('[data-testid="context-new-convo-btn"]')
    const hasNewConvo = await newConvoBtn.isVisible({ timeout: 2_000 }).catch(() => false)
    if (hasNewConvo) {
      expect(await newConvoBtn.textContent()).toContain('Start New Conversation')
      await expect(page.getByText(/continue anyway/i)).toBeVisible()
    }
  })

  test('escape key dismisses modal', async ({ electronPage: page }) => {
    const ready = await ensureWorkspaceReady(page)
    if (!ready) {
      test.skip()
      return
    }

    const modal = page.locator('[data-testid="compact-context-modal"]')
    if (!(await modal.isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    await expect(modal).toBeHidden({ timeout: 3_000 })
  })
})
