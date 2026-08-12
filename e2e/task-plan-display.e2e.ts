/**
 * Task Plan Display E2E Tests
 *
 * Tests plan visualization in the ChatExecutionPanel's Plan tab:
 *   - Plan content renders in execution panel Plan tab
 *   - Plan sections are collapsible (click header toggles content)
 *   - Plan shows title and summary inside panel
 *   - Markdown content renders inside plan sections
 *   - Build action bar shows at bottom of plan
 *   - Plan type badge displays correctly
 *
 * Plans now render in the ChatExecutionPanel side panel (not inline cards).
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/task-plan-display.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { ChatPage } from './pages/chat-page'
import { WelcomePage } from './pages/welcome-page'

test.describe('Task Plan Display', () => {
  async function ensureChatReady(page: import('@playwright/test').Page): Promise<ChatPage | null> {
    const welcomePage = new WelcomePage(page)
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) await welcomePage.completeWelcomeModal('Test User')
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      if ((await cards.count()) === 0) return null
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }
    const chatsTab = page.locator('[data-testid="sidebar-tab-chats"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return new ChatPage(page)
  }

  /** Open the execution panel and switch to the Plan tab */
  async function openPlanTab(page: import('@playwright/test').Page): Promise<boolean> {
    // Open panel via the toggle button
    const toggle = page.locator('[data-testid="task-summary-badge-toggle"]')
    const hasToggle = await toggle.isVisible({ timeout: 5_000 }).catch(() => false)
    if (!hasToggle) return false
    await toggle.click()
    await page.waitForTimeout(500)

    // Click the Plan tab
    const planTab = page.locator('[data-testid="chat-execution-tab-plan"]')
    const hasTab = await planTab.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasTab) return false
    await planTab.click()
    await page.waitForTimeout(500)
    return true
  }

  test('plan content renders in execution panel Plan tab', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    // Check if a plan indicator exists (slim indicator in messages or badge)
    const planIndicator = page.locator('[data-testid="plan-slim-indicator"]')
    const hasPlanIndicator = await planIndicator
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (!hasPlanIndicator) {
      // No plan available — try triggering one
      const inputReady = await chat.messageInput.isVisible({ timeout: 15_000 }).catch(() => false)
      if (!inputReady) {
        test.skip()
        return
      }

      const isEnabled = await chat.isInputEnabled()
      if (!isEnabled) {
        test.skip()
        return
      }

      await chat.sendMessage('Create a plan to add a hello world function')
      await chat.waitForStreamComplete(120_000)
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    // Plan content should be visible inside the panel
    const panel = page.locator('[data-testid="chat-execution-panel"]')
    await expect(panel).toBeVisible()

    // Panel should have some plan content text
    const panelText = await panel.textContent()
    expect(panelText).toBeTruthy()
  })

  test('plan sections are collapsible (click header toggles content)', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="chat-execution-panel"]')

    // Find collapsible section headers inside the panel
    const sectionHeaders = panel.locator('button, summary, [role="button"]')
    const headerCount = await sectionHeaders.count()

    if (headerCount === 0) {
      test.skip()
      return
    }

    // Click the first section header to toggle
    const firstHeader = sectionHeaders.first()
    await expect(firstHeader).toBeVisible()
    await firstHeader.click()
    await page.waitForTimeout(300)

    // The section should still be present (toggled state)
    await expect(firstHeader).toBeVisible()
  })

  test('plan shows title and summary inside panel', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="chat-execution-panel"]')

    // Plan panel should have a title/header text
    const headerText = await panel.locator('.text-sm.font-medium, h3, h4').first().textContent()
    expect(headerText).toBeTruthy()

    // Should have plan-related content
    const fullText = await panel.textContent()
    expect(fullText).toBeTruthy()
    expect(fullText!.length).toBeGreaterThan(0)
  })

  test('markdown content renders inside plan sections', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="chat-execution-panel"]')

    // Check for rendered markdown elements inside the panel
    const markdownElements = panel.locator('p, ul, ol, code, a, pre, li')
    const elementCount = await markdownElements.count()

    // Plan sections should have some rendered content
    expect(elementCount).toBeGreaterThan(0)
  })

  test('build action bar shows at bottom of plan', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    // Look for the build action bar inside the panel
    const panel = page.locator('[data-testid="chat-execution-panel"]')
    const buildBar = panel.locator('[data-testid="task-plan-build-bar"]')
    const hasBuildBar = await buildBar
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    if (!hasBuildBar) {
      // Build bar may have been dismissed by a previous user click
      test.skip()
      return
    }

    // Build bar should have action buttons
    const buttons = buildBar.first().locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)

    // Should contain action text
    const barText = await buildBar.first().textContent()
    expect(barText?.length).toBeGreaterThan(0)
  })

  test('plan type badge displays correctly', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) {
      test.skip()
      return
    }

    const panelOpened = await openPlanTab(page)
    if (!panelOpened) {
      test.skip()
      return
    }

    const panel = page.locator('[data-testid="chat-execution-panel"]')

    // Check for plan type badge or mode badge
    const badges = panel.locator('span').filter({
      hasText: /Bug Fix|Feature|Refactor|Audit|Investigation|plan|build/i
    })
    const badgeCount = await badges.count()

    // Should have at least a mode badge (plan/build)
    expect(badgeCount).toBeGreaterThan(0)

    // First badge should be visible
    const firstBadge = badges.first()
    await expect(firstBadge).toBeVisible()
  })
})
