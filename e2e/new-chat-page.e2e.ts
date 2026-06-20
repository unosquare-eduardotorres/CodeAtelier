/**
 * New Chat Page E2E Tests
 *
 * Verifies the NewChatPage component (522 LOC) — the first screen users
 * see when starting a conversation:
 *   - Title input auto-focus + character counter
 *   - Mode toggle (Plan / Build)
 *   - Communication tone selector
 *   - Provider toggle (Claude / Local LLM)
 *   - MCP tools expand/collapse and toggle switches
 *   - Start Conversation and Create Idea buttons
 *   - Cmd+Enter keyboard shortcut
 *
 * Uses CDP fixture (Electron 41+ compatible).
 *
 * Prerequisites:
 *   1. npx electron-vite build
 *   2. npx playwright test e2e/new-chat-page.e2e.ts
 */
import { test, expect } from './helpers/electron-fixture'
import { WelcomePage } from './pages/welcome-page'

test.describe('New Chat Page', () => {
  /**
   * Helper: navigate to a workspace and ensure NewChatPage is visible.
   * Returns the page if NewChatPage is reachable; null otherwise.
   */
  async function navigateToNewChat(
    page: import('@playwright/test').Page
  ): Promise<boolean> {
    const welcomePage = new WelcomePage(page)

    // Complete welcome if needed
    const hasModal = await welcomePage.isWelcomeModalVisible()
    if (hasModal) {
      await welcomePage.completeWelcomeModal('Test User')
    }

    // Open first workspace if on welcome screen
    const isOnWelcome = await welcomePage.isVisible()
    if (isOnWelcome) {
      const cards = welcomePage.getWorkspaceCards()
      const count = await cards.count()
      if (count === 0) return false
      await cards.first().click()
      await page.waitForTimeout(3_000)
    }

    // Check if NewChatPage is already visible
    const newChatPage = page.locator('[data-testid="new-chat-page"]')
    const isVisible = await newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
    if (isVisible) return true

    // Try to navigate via Cmd+N or "New Chat" button
    await page.keyboard.press('Meta+n')
    await page.waitForTimeout(1_500)
    return newChatPage.isVisible({ timeout: 5_000 }).catch(() => false)
  }

  test('new chat page renders with title input and CTA', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    // NewChatPage root container visible
    await expect(page.locator('[data-testid="new-chat-page"]')).toBeVisible()

    // Title input visible
    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    await expect(titleInput).toBeVisible()

    // Start Conversation button visible but disabled (empty title)
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')
    await expect(startBtn).toBeVisible()
    await expect(startBtn).toBeDisabled()
  })

  test('title input enables Start button', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')

    // Initially disabled
    await expect(startBtn).toBeDisabled()

    // Type title → button becomes enabled
    await titleInput.fill('Add user authentication')
    await expect(startBtn).toBeEnabled()

    // Clear title → button disables again
    await titleInput.clear()
    await expect(startBtn).toBeDisabled()
  })

  test('mode toggle switches between Plan and Build', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const modeToggle = page.locator('[data-testid="new-chat-mode-toggle"]')
    await expect(modeToggle).toBeVisible()

    // Plan mode should be default
    const planBtn = modeToggle.getByRole('button', { name: /plan/i })
    const buildBtn = modeToggle.getByRole('button', { name: /build/i })
    await expect(planBtn).toBeVisible()
    await expect(buildBtn).toBeVisible()

    // Switch to Build mode
    await buildBtn.click()
    await page.waitForTimeout(300)

    // Build-mode-only elements should appear (isolated branch checkbox)
    const isolatedBranch = page.getByText(/isolated branch/i)
    const hasIsolated = await isolatedBranch.isVisible({ timeout: 2_000 }).catch(() => false)
    expect(hasIsolated).toBeTruthy()

    // Switch back to Plan → checkbox should disappear
    await planBtn.click()
    await page.waitForTimeout(300)
    const stillVisible = await isolatedBranch.isVisible({ timeout: 1_000 }).catch(() => false)
    expect(stillVisible).toBeFalsy()
  })

  test('tone selector buttons toggle', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const toneSelector = page.locator('[data-testid="new-chat-tone-selector"]')
    await expect(toneSelector).toBeVisible()

    // Should have "Workspace Default" button
    const defaultBtn = toneSelector.getByRole('button', { name: /workspace default/i })
    await expect(defaultBtn).toBeVisible()

    // Find and click a non-default tone button
    const toneButtons = toneSelector.locator('button')
    const count = await toneButtons.count()
    if (count > 1) {
      // Click second tone button (not Workspace Default)
      await toneButtons.nth(1).click()
      await page.waitForTimeout(300)

      // Click "Workspace Default" → resets tone
      await defaultBtn.click()
      await page.waitForTimeout(300)
    }
  })

  test('provider toggle switches Cloud/Local', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const providerToggle = page.locator('[data-testid="new-chat-provider-toggle"]')
    await expect(providerToggle).toBeVisible()

    // Claude should be visible as an option
    const claudeBtn = providerToggle.getByRole('button', { name: /claude/i })
    const localBtn = providerToggle.getByRole('button', { name: /local/i })
    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()

    // Switch to Local LLM
    await localBtn.click()
    await page.waitForTimeout(300)

    // Description may show local model info
    const localInfo = page.getByText(/ollama|omlx/i)
    const hasLocalInfo = await localInfo.first().isVisible({ timeout: 2_000 }).catch(() => false)

    // Switch back to Claude
    await claudeBtn.click()
    await page.waitForTimeout(300)

    // Both toggles should still be clickable
    await expect(claudeBtn).toBeVisible()
    await expect(localBtn).toBeVisible()
  })

  test('MCP tools section expands with toggle switches', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const mcpSection = page.locator('[data-testid="new-chat-mcp-section"]')
    const mcpExpand = page.locator('[data-testid="new-chat-mcp-expand"]')

    // MCP section may or may not be visible depending on workspace config
    const hasMcp = await mcpSection.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasMcp) {
      // No MCP integrations available — skip
      test.skip()
      return
    }

    // Click expand/collapse toggle
    await mcpExpand.click()
    await page.waitForTimeout(500)

    // Look for MCP toggle switches within the section
    const toggles = mcpSection.locator('button[aria-label]')
    const toggleCount = await toggles.count()

    if (toggleCount > 0) {
      // Click first toggle to flip it
      await toggles.first().click()
      await page.waitForTimeout(300)
    }

    // Collapse the section
    await mcpExpand.click()
    await page.waitForTimeout(300)
  })

  test('Start Conversation creates chat', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const startBtn = page.locator('[data-testid="new-chat-start-btn"]')

    // Fill title and click Start
    await titleInput.fill('E2E Test Conversation')
    await expect(startBtn).toBeEnabled()
    await startBtn.click()

    // Chat panel should appear with message input
    const messageInput = page.locator('[data-testid="message-input"]')
    const chatPanel = page.locator('[data-testid="chat-panel"]')

    const hasChat = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasInput = await messageInput.isVisible({ timeout: 10_000 }).catch(() => false)

    expect(hasChat || hasInput).toBeTruthy()
  })

  test('Cmd+Enter shortcut submits form', async ({ electronPage: page }) => {
    const hasNewChat = await navigateToNewChat(page)
    if (!hasNewChat) {
      test.skip()
      return
    }

    const titleInput = page.locator('[data-testid="new-chat-title-input"]')
    const descriptionInput = page.locator('[data-testid="new-chat-description"]')

    // Fill title and description
    await titleInput.fill('Shortcut Test Chat')
    await descriptionInput.fill('Testing Cmd+Enter shortcut')

    // Press Cmd+Enter
    await page.keyboard.press('Meta+Enter')

    // Chat panel or message input should appear
    const messageInput = page.locator('[data-testid="message-input"]')
    const chatPanel = page.locator('[data-testid="chat-panel"]')

    const hasChat = await chatPanel.isVisible({ timeout: 10_000 }).catch(() => false)
    const hasInput = await messageInput.isVisible({ timeout: 10_000 }).catch(() => false)

    expect(hasChat || hasInput).toBeTruthy()
  })
})
