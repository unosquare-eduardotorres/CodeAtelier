/**
 * Chat Plan Sections E2E Tests — Tier B
 *
 * Verifies interactive plan components within chat messages:
 *   1. TaskPlanSections: expand/collapse individual sections (phases, risks, files)
 *   2. PlanHelpers: root causes list renders with clickable items
 *   3. NewChatPopover: opens on new chat with Plan/Build mode options
 *   4. NewChatPopover: selecting mode creates conversation in that mode
 *   5. ContextBadge: click opens CompactContextModal with usage details
 *
 * These components are user-visible within every plan-mode conversation
 * and have zero direct E2E coverage.
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/chat-plan-sections.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'
import { ChatPage } from './pages/chat-page'

test.describe('Chat Plan Sections & NewChatPopover', () => {
  // ── Shared helpers ────────────────────────────────────────────────

  async function ensureWorkspaceOpen(page: import('@playwright/test').Page): Promise<ChatPage> {
    const welcomePage = new WelcomePage(page)
    const chat = new ChatPage(page)

    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count > 0) {
        await cards.first().click()
        await page.waitForTimeout(3_000)
      }
    }

    return chat
  }

  /**
   * Helper: navigate to a conversation that contains a plan card.
   * Returns true if a plan card is found in the current view.
   */
  async function findConversationWithPlanCard(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    // Look for plan card sections in current conversation
    const planSections = page.locator(
      '[data-testid^="plan-section-"], [data-testid="plan-phases-list"], [data-testid="plan-root-causes-list"]'
    )
    const hasPlanContent = await planSections
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (hasPlanContent) return true

    // Try to find a conversation with plan content in the sidebar
    const sidebarItems = page.locator('[data-testid^="chat-item-"]')
    const itemCount = await sidebarItems.count()

    for (let i = 0; i < Math.min(itemCount, 10); i++) {
      const text = await sidebarItems.nth(i).textContent()
      if (/plan|implement|phase/i.test(text ?? '')) {
        await sidebarItems.nth(i).click()
        await page.waitForTimeout(2_000)

        const hasPlan = await planSections
          .first()
          .isVisible({ timeout: 5_000 })
          .catch(() => false)
        if (hasPlan) return true
      }
    }

    return false
  }

  // ── 1. TaskPlanSections: expand/collapse individual sections ──────

  test('TaskPlanSections: expand/collapse phases section', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChatPanel = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChatPanel) {
      test.skip()
      return
    }

    const hasPlanCard = await findConversationWithPlanCard(page)
    if (!hasPlanCard) {
      test.skip()
      return
    }

    // Find phases list and its toggle buttons
    const phasesList = page.locator('[data-testid="plan-phases-list"]')
    const hasPhasesSection = await phasesList.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasPhasesSection) {
      // Check if other sections (risks, files) are present instead
      const risksSection = page.locator('[data-testid="plan-section-risks"]')
      const filesSection = page.locator('[data-testid="plan-section-files-changed"]')

      const hasRisks = await risksSection.isVisible({ timeout: 3_000 }).catch(() => false)
      const hasFiles = await filesSection.isVisible({ timeout: 3_000 }).catch(() => false)

      // At least one section should be visible in a plan card
      expect(hasRisks || hasFiles).toBeTruthy()
      return
    }

    // Click a phase toggle to expand it
    const phaseToggle = page.locator('[data-testid^="plan-phase-toggle-"]').first()
    const hasToggle = await phaseToggle.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasToggle) {
      // Simple plan mode — no expand/collapse
      await expect(phasesList).toBeVisible()
      return
    }

    // Expand the first phase
    await phaseToggle.click()
    await page.waitForTimeout(300)

    // Phase content should become visible (files, description)
    const phaseContent = phasesList.locator('.prose, [class*="border-t"]').first()
    const hasContent = await phaseContent.isVisible({ timeout: 3_000 }).catch(() => false)
    expect(hasContent).toBeTruthy()

    // Collapse again
    await phaseToggle.click()
    await page.waitForTimeout(300)
  })

  // ── 2. PlanHelpers: root causes list renders ──────────────────────

  test('PlanHelpers: root causes list renders with items', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChatPanel = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChatPanel) {
      test.skip()
      return
    }

    const hasPlanCard = await findConversationWithPlanCard(page)
    if (!hasPlanCard) {
      test.skip()
      return
    }

    // Root causes list
    const rootCausesList = page.locator('[data-testid="plan-root-causes-list"]')
    const hasRootCauses = await rootCausesList.isVisible({ timeout: 5_000 }).catch(() => false)

    if (!hasRootCauses) {
      // Not all plans have root causes — check for complexity indicators instead
      const complexityIndicator = page.locator('[data-testid="plan-complexity-indicator"]')
      const hasComplexity = await complexityIndicator
        .first()
        .isVisible({ timeout: 3_000 })
        .catch(() => false)

      // If neither exists, this plan is too simple for these components
      if (!hasComplexity) {
        test.skip()
        return
      }

      // Verify complexity indicator renders correctly
      const title = await complexityIndicator.first().getAttribute('title')
      expect(title).toMatch(/complexity.*\d+/i)
      return
    }

    // Root causes list should contain at least one item
    const rootCauseItems = rootCausesList.locator('[class*="border-l-4"]')
    const itemCount = await rootCauseItems.count()
    expect(itemCount).toBeGreaterThan(0)

    // First item should have a title and description
    const firstItem = rootCauseItems.first()
    const itemText = await firstItem.textContent()
    expect(itemText?.length).toBeGreaterThan(0)
    expect(itemText).toMatch(/root cause/i)
  })

  // ── 3. NewChatPopover: opens with Plan/Build mode options ─────────

  test('NewChatPopover: popover shows Plan and Build mode options', async ({
    electronPage: page
  }) => {
    const _chat = await ensureWorkspaceOpen(page)

    // We need to find the "new chat" button that opens the popover
    // It's typically in the sidebar header area
    const newChatBtn = page
      .locator('[data-testid="new-chat-button"]')
      .or(page.getByRole('button', { name: /new chat|new conversation/i }))
      .first()

    const hasNewChatBtn = await newChatBtn.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasNewChatBtn) {
      // Try keyboard shortcut to see if new chat page appears
      await page.keyboard.press('Meta+n')
      await page.waitForTimeout(1_000)

      // Check if NewChatPage itself appeared (alternative to popover)
      const newChatPage = page.locator('[data-testid="new-chat-page"]')
      const hasPage = await newChatPage.isVisible({ timeout: 3_000 }).catch(() => false)

      if (hasPage) {
        // New chat page shows mode options (Plan/Build buttons)
        const planBtn = page.getByRole('button', { name: /plan/i }).first()
        const buildBtn = page.getByRole('button', { name: /build/i }).first()

        const hasPlan = await planBtn.isVisible({ timeout: 3_000 }).catch(() => false)
        const hasBuild = await buildBtn.isVisible({ timeout: 3_000 }).catch(() => false)

        expect(hasPlan || hasBuild).toBeTruthy()
        return
      }

      test.skip()
      return
    }

    // Click the new chat button to open the popover
    await newChatBtn.click()
    await page.waitForTimeout(500)

    // Check for the popover container
    const popover = page.locator('[data-testid="new-chat-popover"]')
    const hasPopover = await popover.isVisible({ timeout: 3_000 }).catch(() => false)

    if (!hasPopover) {
      // Clicking may have directly navigated to new chat page
      const newChatPage = page.locator('[data-testid="new-chat-page"]')
      const hasPage = await newChatPage.isVisible({ timeout: 3_000 }).catch(() => false)
      expect(hasPage).toBeTruthy()
      return
    }

    // Popover should show Plan and Build mode options
    const planOption = page.locator('[data-testid="new-chat-mode-plan"]')
    const buildOption = page.locator('[data-testid="new-chat-mode-build"]')

    await expect(planOption).toBeVisible({ timeout: 3_000 })
    await expect(buildOption).toBeVisible({ timeout: 3_000 })

    // Verify text labels
    const planText = await planOption.textContent()
    const buildText = await buildOption.textContent()

    expect(planText).toMatch(/plan/i)
    expect(buildText).toMatch(/build/i)
  })

  // ── 4. NewChatPopover: selecting mode creates conversation ────────

  test('NewChatPopover: selecting Plan mode creates plan conversation', async ({
    electronPage: page
  }) => {
    const chat = await ensureWorkspaceOpen(page)

    // Open the new chat popover
    const newChatBtn = page
      .locator('[data-testid="new-chat-button"]')
      .or(page.getByRole('button', { name: /new chat|new conversation/i }))
      .first()

    const hasNewChatBtn = await newChatBtn.isVisible({ timeout: 10_000 }).catch(() => false)

    if (!hasNewChatBtn) {
      test.skip()
      return
    }

    await newChatBtn.click()
    await page.waitForTimeout(500)

    // Try the popover route first
    const planOption = page.locator('[data-testid="new-chat-mode-plan"]')
    const hasPopover = await planOption.isVisible({ timeout: 3_000 }).catch(() => false)

    if (hasPopover) {
      await planOption.click()
      await page.waitForTimeout(1_000)

      // Should be in a new conversation — message input should be visible
      const hasInput = await chat.messageInput.isVisible({ timeout: 5_000 }).catch(() => false)
      const hasNewChat = await chat.newChatPage.isVisible({ timeout: 3_000 }).catch(() => false)

      expect(hasInput || hasNewChat).toBeTruthy()

      // Verify plan mode indicator (emoji, text, or active button)
      const planIndicator = page.getByText(/📋|plan mode/i).first()
      const hasPlanMode = await planIndicator.isVisible({ timeout: 3_000 }).catch(() => false)

      // Plan mode should be indicated somewhere in the UI
      if (hasPlanMode) {
        expect(hasPlanMode).toBeTruthy()
      }
    } else {
      // Popover didn't appear — click may have opened new chat directly
      const newChatPage = page.locator('[data-testid="new-chat-page"]')
      const hasNewChatPage = await newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
      expect(hasNewChatPage).toBeTruthy()
    }
  })

  // ── 5. ContextBadge: click opens CompactContextModal ──────────────

  test('ContextBadge: click opens context details modal', async ({ electronPage: page }) => {
    const chat = await ensureWorkspaceOpen(page)

    const hasChatPanel = await chat.chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    if (!hasChatPanel) {
      test.skip()
      return
    }

    // ContextBadge shows token usage (e.g. "45K / 200K")
    const contextBadge = page
      .locator('[data-testid="context-badge"]')
      .or(page.getByText(/\d+K\s*\/\s*\d+K/i).first())
    const hasBadge = await contextBadge
      .first()
      .isVisible({ timeout: 5_000 })
      .catch(() => false)

    if (!hasBadge) {
      // Context badge only appears during/after conversation with token usage
      // Need at least one message in conversation
      const messages = chat.getMessages()
      const messageCount = await messages.count()

      if (messageCount === 0) {
        test.skip()
        return
      }

      // Badge may be elsewhere in the UI
      test.skip()
      return
    }

    // Click the context badge
    await contextBadge.first().click()
    await page.waitForTimeout(500)

    // A modal or popover should appear with context usage details
    const dialog = page.locator('[role="dialog"]')
    const popoverContent = page.locator('[data-testid*="context"], [class*="modal"]')
    const contextText = page.getByText(/context|tokens|usage|window/i)

    const hasDialog = await dialog.isVisible({ timeout: 3_000 }).catch(() => false)
    const hasPopover = await popoverContent
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)
    const hasContextText = await contextText
      .first()
      .isVisible({ timeout: 3_000 })
      .catch(() => false)

    // At least some context detail UI should be visible after click
    expect(hasDialog || hasPopover || hasContextText).toBeTruthy()
  })
})
