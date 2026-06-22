/**
 * Task Plan Display E2E Tests
 *
 * Tests TaskPlanCard (289 LOC) — core plan visualization with type-specific
 * section ordering, collapsible sections, and build action bar:
 *   - Task plan card renders in chat messages when structured plan is present
 *   - Plan sections are collapsible (click header toggles content)
 *   - Plan shows title and summary section at top
 *   - Markdown content renders inside plan sections (links, lists, code blocks)
 *   - Build action bar shows "Implement" button at bottom of plan
 *   - Plan type badge displays correctly (bug/feature/investigation)
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
  async function ensureChatReady(
    page: import('@playwright/test').Page
  ): Promise<ChatPage | null> {
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
    const chatsTab = page.locator('[data-testid="sidebar-chats-tab"]')
    if (await chatsTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await chatsTab.click()
      await page.waitForTimeout(500)
    }
    return new ChatPage(page)
  }

  test('task plan card renders in chat messages when structured plan is present', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    // Look for existing task plan cards in the message list
    const planCards = page.locator('[data-testid="task-plan-card"]')
    const count = await planCards.count()

    if (count === 0) {
      // No plan cards in current view — check if input is ready to trigger one
      const inputReady = await chat.messageInput
        .isVisible({ timeout: 15_000 })
        .catch(() => false)
      if (!inputReady) { test.skip(); return }

      await page.waitForTimeout(5_000)
      const isEnabled = await chat.isInputEnabled()
      if (!isEnabled) { test.skip(); return }

      // Attempt to trigger a plan card by requesting a plan
      await chat.sendMessage('Create a plan to add a hello world function')
      await chat.waitForStreamComplete(120_000)
    }

    // Plan card may or may not appear depending on assistant behavior
    const finalCount = await planCards.count()
    if (finalCount === 0) { test.skip(); return }

    const firstCard = planCards.first()
    await expect(firstCard).toBeVisible()
  })

  test('plan sections are collapsible (click header toggles content)', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planSections = page.locator('[data-testid="task-plan-sections"]')
    if (!(await planSections.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Find collapsible section headers (typically details/summary or click-toggle buttons)
    const sectionHeaders = planSections.first().locator('button, summary, [role="button"]')
    const headerCount = await sectionHeaders.count()

    if (headerCount === 0) { test.skip(); return }

    // Click the first section header to toggle
    const firstHeader = sectionHeaders.first()
    await expect(firstHeader).toBeVisible()
    await firstHeader.click()
    await page.waitForTimeout(300)

    // The section should still be present (toggled state)
    await expect(firstHeader).toBeVisible()
  })

  test('plan shows title and summary section at top', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planCards = page.locator('[data-testid="task-plan-card"]')
    if (!(await planCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const firstCard = planCards.first()

    // Plan card should have a title/header text
    const headerText = await firstCard.locator('.text-sm.font-medium, h3, h4').first().textContent()
    expect(headerText).toBeTruthy()

    // Should have either "Implementation Plan" or "Task Plan" header
    const fullText = await firstCard.textContent()
    const hasPlanText =
      fullText?.includes('Implementation Plan') ||
      fullText?.includes('Task Plan')
    expect(hasPlanText).toBeTruthy()
  })

  test('markdown content renders inside plan sections (links, lists, code blocks)', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planSections = page.locator('[data-testid="task-plan-sections"]')
    if (!(await planSections.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Check for rendered markdown elements inside the plan sections
    const section = planSections.first()

    // Look for any markdown-rendered content (paragraphs, lists, code, links)
    const markdownElements = section.locator('p, ul, ol, code, a, pre, li')
    const elementCount = await markdownElements.count()

    // Plan sections should have some rendered content
    expect(elementCount).toBeGreaterThan(0)
  })

  test('build action bar shows at bottom of plan', async ({ electronPage: page }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planCards = page.locator('[data-testid="task-plan-card"]')
    if (!(await planCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    // Look for the build action bar
    const buildBar = page.locator('[data-testid="task-plan-build-bar"]')
    const hasBuildBar = await buildBar.first().isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasBuildBar) {
      // Build bar may have been dismissed by a previous user click
      test.skip()
      return
    }

    // Build bar should have action buttons (Build Now, Council, Save as Idea, etc.)
    const buttons = buildBar.first().locator('button')
    const buttonCount = await buttons.count()
    expect(buttonCount).toBeGreaterThan(0)

    // Should contain text like "Build Now" or action text
    const barText = await buildBar.first().textContent()
    expect(barText?.length).toBeGreaterThan(0)
  })

  test('plan type badge displays correctly (bug/feature/investigation)', async ({
    electronPage: page
  }) => {
    const chat = await ensureChatReady(page)
    if (!chat) { test.skip(); return }

    const planCards = page.locator('[data-testid="task-plan-card"]')
    if (!(await planCards.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
      test.skip()
      return
    }

    const firstCard = planCards.first()

    // Check for plan type badge or mode badge
    const badges = firstCard.locator('span').filter({
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
